export abstract class BatchJob {
  abstract async run(): Promise<unknown>;

  /**
   * 인스턴스 폐기
   * BatchManager 에서 이벤트를 받아 처리
   * 주의사항 : 이 메소드를 실행하기 전에 프로세스가 즉시 중단되어도 문제 없도록 데이터를 정리해야 함.
   */
  protected async discardInstance(): Promise<void> {
    process.emit('SIGUSR1', 'SIGUSR1');
  }

  /**
   * IP가 차단된 크롤러 인스턴스의 IP를 변경하고,
   * 변경 실폐시 인스턴스를 폐기.
   */
  protected async revivalIpBlockedCrawler(): Promise<void> {
    process.emit('SIGUSR2', 'SIGUSR2');
  }
}
