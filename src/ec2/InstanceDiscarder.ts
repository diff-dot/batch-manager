import pm2, { ProcessDescription } from 'pm2';
import os from 'os';
import fs from 'fs';
import AWS from 'aws-sdk';
import { EC2MetaData } from './EC2Metadata';
import PromiseUtils from '../utils/PromiseUtils';
import { ConfigManager } from '@diff./config-manager';

// discard 중 에러 발생시 재시도 주기
const RETRY_INTERVAL = 10 * 1000;

// 지정된 시간동안 Discard 가 완료되지 않을 경우 인스턴스 강제 삭제
const DISCARD_TIMEOUT = 600 * 1000;

export class InstanceDiscarder {
  private assignedAsgNames?: string[];
  private isDiscarding = false;
  private killProcessTimeoutHandle?: NodeJS.Timeout;

  /**
   * IP 차단 등의 이유로 직접 현재 인스턴스를 안전하게 폐기하고자 할 때 사용
   * @param assignedAsgNames 인스턴스가 소속된 autoscaling group 이 있을 경우
   */
  constructor(assignedAsgNames?: string[]) {
    this.assignedAsgNames = assignedAsgNames;
    if (this.pidFileExists()) {
      console.warn('[InstanceDiscarder] PID file exists at construction time.');
    }
  }

  /**
   * 인스턴스 폐기 이벤트를 수신했을 경우, 실행중인 모든 프로세스를 종료하고
   * 1. PM2 로 실행중인 모든 프로세르를 안전하게 종료
   * 2. 오토 스케일링 그룹에 소속되어 있을경우 그룹에서 제거
   * 3. 인스턴스 삭제 요청
   * 를 순차진행, 단 TIMEOUT_WORK_LOCK_DURATION 동안 위 작업이 완료되지 않으면 인스턴스 강제 종료
   */

  // TODO 다수가 supervisionprocess 로 선정되어 서로를 죽이니 인스턴스 삭제도, 타임아웃도 실행되지 아니한다.
  public async discard(): Promise<void> {
    // 주관 프로세스가 아닌 경우 리턴
    if (!this.isSupervisionProcess()) {
      return;
    }

    if (this.isDiscarding) {
      console.log('[Discard] 폐기가 진행중입니다.');
      return;
    } else {
      console.log(`[Discard] 이 프로세스(PID:${process.pid})가 인스턴스 폐기를 주관합니다.`);
      this.isDiscarding = true;
    }

    // TIMEOUT 이벤트 등록
    if (!this.killProcessTimeoutHandle) {
      this.killProcessTimeoutHandle = setInterval(async () => {
        try {
          console.error('[Discard] 프로세스 종료 대기 시간이 초과하여 인스턴스를 즉시 폐기합니다.');
          await this.terminateInstance();
        } catch (e) {}
      }, DISCARD_TIMEOUT);
    }

    // 나 자신을 제외한 모든 프로세스 중지
    let supervisionProcessPmId: number | undefined;
    const tasks: Promise<void>[] = [];

    try {
      await this.connectPM2();
      const processList = await this.nodeProcesses();
      for (const proc of processList) {
        if (proc.pm_id === undefined || proc.pm2_env === undefined) continue;

        if (proc.pid === process.pid) {
          supervisionProcessPmId = proc.pm_id;
        } else {
          if (proc.pm2_env.status === 'online' || proc.pm2_env.status === 'launching') {
            console.log(`[Discard] 프로세스 종료 요청 PID:${proc.pid} / PMID: ${proc.pm_id}`);
            tasks.push(this.stopNodeProcess(proc.pm_id));
          }
        }
      }

      // 프로세스 종료 프로미스 일괄 실행
      if (tasks.length) await Promise.all(tasks);
      console.log('[Discard] 프로세스 종료 완료');

      // 인스턴스 삭제
      await this.terminateInstance();

      // PID 파일 삭제
      console.log('[Discard] PID 파일 삭제');
      this.unlinkPidFile();

      // 타임아웃 이벤트 삭제
      if (this.killProcessTimeoutHandle) {
        clearInterval(this.killProcessTimeoutHandle);
        this.killProcessTimeoutHandle = undefined;
      }

      // 현재 프로세스종료
      if (supervisionProcessPmId !== undefined) {
        await this.stopNodeProcess(supervisionProcessPmId);

        // 신호 수신까지 대기
        console.log('[Discard] 주관 프로세스 종료 완료시까지 대기');
        await PromiseUtils.usleep(Infinity);
      }

      this.isDiscarding = false;
    } catch (e) {
      console.error('[Discard] 인스턴스 폐기 중 오류발생', e);
      this.isDiscarding = false;

      // 재시도
      setTimeout(async () => {
        await this.discard();
      }, RETRY_INTERVAL);
    }
  }

  private async terminateInstance(): Promise<void> {
    if (!ConfigManager.isProduction()) return;

    // 인스턴스ID 확인
    console.log('[Discard] 인스턴스 IP확인');
    const instanceMeta = await EC2MetaData.metadata();

    // 인스턴스 삭제
    console.log('[Discard] 인스턴스 폐기');
    const ec2 = new AWS.EC2({ region: instanceMeta.region });
    await ec2.terminateInstances({ InstanceIds: [instanceMeta.instanceId] }).promise();

    // 인스턴스가 소속된 autoscaling group 이 있을 경우 그룹에서 제외
    console.log('[Discard] 오토스케일링 그룹에서 인스턴스 삭제');
    if (this.assignedAsgNames) {
      const asg = new AWS.AutoScaling({ region: instanceMeta.region });

      // const instances = await asg
      //   .describeAutoScalingInstances({
      //     InstanceIds: [instanceMeta.instanceId]
      //   })
      //   .promise();
      // asg.instance;
      // if (instances && instances.AutoScalingInstances) {
      // }

      for (const asgName of this.assignedAsgNames) {
        await asg
          .detachInstances({
            AutoScalingGroupName: asgName,
            ShouldDecrementDesiredCapacity: false,
            InstanceIds: [instanceMeta.instanceId]
          })
          .promise();
      }
    }
  }

  private isSupervisionProcess(): boolean {
    try {
      fs.writeFileSync(this.pidFile(), process.pid, { flag: 'wx' });
    } catch (e) {
      const spid = parseInt(fs.readFileSync(this.pidFile(), 'utf8'));
      if (spid === process.pid) return true;
      return false;
    }

    return true;
  }

  private pidFileExists() {
    return fs.existsSync(this.pidFile());
  }

  private pidFile(): string {
    return `${os.tmpdir()}/instance-discarder.pid`;
  }

  private unlinkPidFile() {
    try {
      fs.unlinkSync(this.pidFile());
    } catch (e) {}
  }

  /**
   * PM2 접속
   */
  private connectPM2(): Promise<void> {
    return new Promise((resolve, reject) => {
      pm2.connect(err => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  /**
   * PM2 에 등록된 모든 프로세스 목록 반환
   */
  private nodeProcesses(): Promise<ProcessDescription[]> {
    return new Promise((resolve, reject) => {
      pm2.list((err, res) => {
        if (err) return reject(res);
        return resolve(res);
      });
    });
  }

  /**
   * PM2에 등록된 특정 프로세스 중단
   */
  private stopNodeProcess(pmId: number): Promise<void> {
    return new Promise((resolve, reject) => {
      pm2.stop(pmId, err => {
        if (err) return reject(err);
        resolve();
      });
    });
  }
}
