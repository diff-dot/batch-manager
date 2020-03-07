import { EC2MetaData } from './EC2Metadata';
import AWS, { EC2 } from 'aws-sdk';
import PromiseUtils from '../utils/PromiseUtils';
import { InstanceNetworkInterface } from 'aws-sdk/clients/ec2';
import rp from 'request-promise-native';
import os from 'os';
import fs from 'fs';

// DHCP 를 통해 신규 IP가 적용되기까지 대기할 시간(ms)
const IP_CHANGE_LEADTIME = 10000;

// MYIP 확인 API
const MYIP_API_ENDPOINT = 'http://echo-ipv6.playboard.internal:8080';
const MYIP_CHECK_RETRY = 30;
const MYIP_CHECK_RETRY_DURATION = 5000;
const MYIP_CHECK_TIMEOUT = 1000;

export class InstanceIpManager {
  private isWorking = false;

  constructor() {
    if (this.pidFileExists()) {
      console.warn('[InstanceIpManager] PID file exists at construction time.');
    }
  }

  public async changeIpv6(args: { discardIfFailed: boolean }): Promise<string | undefined> {
    const { discardIfFailed = false } = args;
    if (await this.isSupervisionProcess()) {
      if (this.isWorking) {
        this.info('IP 변경이 진행중입니다.');
        return;
      } else {
        this.info(`이 프로세스(PID:${process.pid})가 IP변경을 주관합니다.`);
        this.isWorking = true;
      }
    } else {
      return;
    }

    try {
      const newIp = await this.requestChangeIpV6();
      console.log(`새 IP 획득 ${newIp}`);
      this.isWorking = false;
      this.unlinkPidFile();

      // IP가 변경되었으므로, 프로세스 재계 요청 신호 발송
      process.emit('SIGCONT', 'SIGCONT');

      return newIp;
    } catch (e) {
      this.isWorking = false;
      this.unlinkPidFile();

      // IP 변경에 실패했으므로, 인스턴스 폐기 신호 발송
      if (discardIfFailed) {
        process.emit('SIGUSR1', 'SIGUSR1');
      }

      throw e;
    }
  }

  private async requestChangeIpV6(): Promise<string> {
    // 인스턴스 ID확인
    const instanceMeta = await EC2MetaData.metadata();
    const ec2 = new AWS.EC2({ region: instanceMeta.region });

    // 네트워크 인터페이스 확인
    this.info('네트워크 정보를 확인합니다.');
    const networkInfo = await this.networkInfo(ec2, instanceMeta.instanceId);

    // 기존 IP 제거
    this.info('기존 ipv6 를 모두 제거합니다.');
    if (networkInfo.ips) {
      if (networkInfo.ips.length) {
        await ec2
          .unassignIpv6Addresses({
            NetworkInterfaceId: networkInfo.id,
            Ipv6Addresses: networkInfo.ips
          })
          .promise();
      }
    }

    // 신규 IP 추가
    this.info('신규 ipv6 를 추가합니다.');
    const assignedResult = await ec2
      .assignIpv6Addresses({
        NetworkInterfaceId: networkInfo.id,
        Ipv6AddressCount: 1
      })
      .promise();
    if (!assignedResult || !assignedResult.AssignedIpv6Addresses) throw new Error('신규 ipv6 할당에 실패했습니다.');
    const newIp = assignedResult.AssignedIpv6Addresses[0];

    // 자동 배정된 IP가 기존에 사용하던 IP 인지 확인
    if (networkInfo.ips.indexOf(newIp) !== -1) {
      throw new Error('기존에 사용하던 ipv6 가 재할당 되었거나, IP 변경에 실패했습니다.');
    }

    this.info(`DHCP 반영시까지 잠시 대기합니다. (${IP_CHANGE_LEADTIME}msec)`);
    await PromiseUtils.usleep(IP_CHANGE_LEADTIME);

    // 원격지의 서버를 통해 실제 IP 변경 완료 여부 체크
    let changedConfirm = false;
    for (let i = 0; i < MYIP_CHECK_RETRY; i++) {
      this.info(`ipv6 변경 완료 여부를 체크합니다. (${i + 1}/${MYIP_CHECK_RETRY})`);
      try {
        const ipFromRemote = await this.myIpFromRemote();
        if (ipFromRemote === newIp) {
          changedConfirm = true;
          break;
        }
      } catch (e) {
        // Ignore error
      }
      await PromiseUtils.usleep(MYIP_CHECK_RETRY_DURATION);
    }
    if (!changedConfirm) throw new Error('신규 ipv6 할당에 실패했습니다.');

    return newIp;
  }

  private async myIpFromRemote(): Promise<string> {
    // TCPSOCK 타임 아웃 수동 대응
    return new Promise(async (resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        return reject(new Error('myIpFromRemote Timeout'));
      }, MYIP_CHECK_TIMEOUT * 2);

      const ip = await rp.get({
        url: MYIP_API_ENDPOINT,
        timeout: MYIP_CHECK_TIMEOUT
      });
      clearTimeout(timeoutHandle);
      resolve(ip);
    });
  }

  private async networkInfo(client: EC2, instanceId: string): Promise<{ id: string; ips: string[] }> {
    const instanceDetail = await client
      .describeInstances({
        InstanceIds: [instanceId]
      })
      .promise();
    if (!instanceDetail) throw new Error('인스턴스 정보를 확인하지 못했습니다.');

    let networkInterface: InstanceNetworkInterface | undefined;
    for (const reservation of instanceDetail.Reservations || []) {
      for (const instance of reservation.Instances || []) {
        for (const ninterface of instance.NetworkInterfaces || []) {
          networkInterface = ninterface;
        }
      }
    }
    if (!networkInterface || !networkInterface.NetworkInterfaceId) throw new Error('네트워크 인스턴스 정보를 가져오지 못했습니다.');

    // IP 추출
    const ips: string[] = [];
    if (networkInterface.Ipv6Addresses) {
      for (const ip of networkInterface.Ipv6Addresses) {
        if (ip.Ipv6Address) ips.push(ip.Ipv6Address);
      }
    }

    return {
      id: networkInterface.NetworkInterfaceId,
      ips
    };
  }

  private async isSupervisionProcess(): Promise<boolean> {
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
    return `${os.tmpdir()}/instance-ip-manager.pid`;
  }

  private unlinkPidFile() {
    try {
      fs.unlinkSync(this.pidFile());
    } catch (e) {}
  }

  private info(message: string) {
    console.info('[InstanceIpManager] ' + message);
  }
}
