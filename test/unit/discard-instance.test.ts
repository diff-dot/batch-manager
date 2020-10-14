// import { expect } from 'chai';
import { InstanceDiscarder } from '../../src/ec2/InstanceDiscarder';

const discarder = new InstanceDiscarder();

describe('discard-instance', async () => {
  it('mark super vision process', async () => {
    await discarder.discard();
  });
});
