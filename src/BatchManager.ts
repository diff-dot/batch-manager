'use strict';
import { CronJob } from 'cron';
import { BatchJob } from './BatchJob';
import { InstanceDiscarder } from './ec2/InstanceDiscarder';
import { InstanceIpManager } from './ec2/InstanceIpManager';
import PromiseUtils from './utils/PromiseUtils';
import { LoggerFactory, LoggerConfig } from '@diff./logger-factory';
import { ConfigManager } from '@diff./config-manager';
import { Timer } from '@diff./timer';

const HOLDED_JOB_WAIT_INTERVAL = 1000;

type ClassType<T> = {
  new (...args: unknown[]): T;
};

export class BatchManager {
  // eslint-disable-next-line
  private logger: any;
  private needKillProcess = false;
  private nowRunningTask = 0;
  private isDiscarding = false;
  private isIpChanging = false;

  private instanceDiscarder: InstanceDiscarder;
  private instanceIpManager: InstanceIpManager;

  /**
   * 배치 작업을 관장하는 매니저
   * @param jobName : 작업 이름
   * @param asgNames : 작업이 autoscaling group 에 등록된 인스턴스에서 동작하는 경우
   * @param caputerConsoleLog : 콜솔로그를 cloudwatch 로 캡쳐
   */
  constructor(args: {
    jobName: string;
    config: ConfigManager<LoggerConfig>;
    asgNames?: string[];
    caputerConsoleLog?: boolean;
    region?: string;
    enableDiscarder?: boolean;
    enableIpManager?: boolean;
  }) {
    const { jobName, config, asgNames, caputerConsoleLog = true, region, enableDiscarder = true, enableIpManager = true } = args;

    const loggerFactory = new LoggerFactory(config);
    this.logger = loggerFactory.create({ groupDepthedName: ['batch', jobName], region });
    if (caputerConsoleLog) LoggerFactory.captureConsoleMessage(this.logger);

    this.instanceDiscarder = new InstanceDiscarder(asgNames);
    this.instanceIpManager = new InstanceIpManager();

    // 인스턴스 폐기 요청 이벤트 수신
    process.on('SIGUSR1', async () => {
      if (!enableDiscarder) return;
      this.isDiscarding = true;

      // 인스턴스 폐기
      await this.instanceDiscarder.discard();
    });

    // 인스턴스 IP 변경 시도, 실폐시 인스턴스 폐기
    process.on('SIGUSR2', async () => {
      console.log('IP교체 요청 메세지 수신');
      if (!enableIpManager) return;
      this.isIpChanging = true;

      await this.instanceIpManager.changeIpv6({ discardIfFailed: true });
    });

    // 프로세스 재게 신호 수신.
    // 테스트 일시 중지에 관련된 플레그 초기화
    process.on('SIGCONT', async () => {
      console.log(`receive SIGCONT message, restart tasks`);
      this.isIpChanging = false;
    });

    // 프로세스 KILL 이벤트를 수신했을 경우, 한 사이클이 종료된 시점에 프로세스 KILL하기 위해 추가
    process.on('SIGINT', () => {
      console.log(`receive KILL message, ${this.nowRunningTask} task is running.`);
      this.needKillProcess = true;
      this.nextTick();
    });
  }

  private nextTick() {
    // 현재 실행중인 부킹 프로세스가 없고 프로세스 종료가 예약되어 있는 경우
    if (this.nowRunningTask === 0 && this.needKillProcess) {
      console.log('KILLED this process.');
      process.exit(0);
    }
  }

  /**
   * 작업 예약
   * @see https://www.npmjs.com/package/cron#cron-ranges
   */
  booking(jobName: string, schedule: string, task: ClassType<BatchJob>) {
    console.info(`실행예약 : ${jobName} > ${schedule}`);

    new CronJob(
      schedule,
      async () => {
        if (this.isDiscarding || this.isIpChanging || this.needKillProcess) return;

        this.nowRunningTask++;
        const timer = new Timer();
        timer.start();

        try {
          console.info(`${jobName} is check in`);
          await new task().run();
        } catch (e) {
          console.error(e);
        }
        console.info(`${jobName} is check out`, { time: timer.check() + 'ms' });
        this.nowRunningTask--;
        this.nextTick();
      },
      undefined,
      true
    );
  }

  async infinite(jobName: string, task: ClassType<BatchJob>): Promise<void>;
  async infinite(jobName: string, tasks: ClassType<BatchJob>[]): Promise<void>;
  async infinite(jobName: string, taskOrTasks: ClassType<BatchJob> | ClassType<BatchJob>[]): Promise<void> {
    console.info(`반복 테스크 등록 : ${jobName}`);

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (this.isDiscarding || this.isIpChanging || this.needKillProcess) {
        await PromiseUtils.usleep(HOLDED_JOB_WAIT_INTERVAL);
        this.nextTick();
        continue;
      }

      this.nowRunningTask++;
      const timer = new Timer();
      timer.start();

      console.info(`${jobName} is start.`);
      try {
        if (Array.isArray(taskOrTasks)) {
          const runners = taskOrTasks.map(v => new v().run());
          await Promise.all(runners);
        } else {
          await new taskOrTasks().run();
        }
        console.info(`${jobName} is completed in `, { time: timer.check() + 'ms' });
      } catch (e) {
        console.error(e);
      }
      this.nowRunningTask--;
      this.nextTick();
    }
  }
}
