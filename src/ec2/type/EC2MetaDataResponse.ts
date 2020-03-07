export interface EC2MetaDataResponse {
  accountId: string;
  architecture: string;
  availabilityZone: string;
  // billingProducts: null;
  // devpayProductCodes: null;
  // marketplaceProductCodes: null;
  imageId: string;
  instanceId: string;
  instanceType: string;
  // kernelId: null;
  pendingTime: string;
  privateIp: string;
  ramdiskId: string | null;
  region: string;
  version: string;
}
