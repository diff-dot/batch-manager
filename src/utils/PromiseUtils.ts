export default class PromiseUtils {
  static async usleep(duration: number) {
    await new Promise(resolve => {
      setTimeout(() => {
        resolve();
      }, duration);
    });
  }
}
