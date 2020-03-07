import rp from 'request-promise-native';
import { EC2MetaDataResponse } from './type/EC2MetaDataResponse';

const MetaDataURI = 'http://169.254.169.254';

export class EC2MetaData {
  static async instanceId() {
    const meta = await this.metadata();
    return meta.instanceId;
  }

  static async metadata(): Promise<EC2MetaDataResponse> {
    const uri = `${MetaDataURI}/latest/dynamic/instance-identity/document`;
    const res = await rp(uri);
    const json = JSON.parse(res) as EC2MetaDataResponse;
    return json;
  }
}
