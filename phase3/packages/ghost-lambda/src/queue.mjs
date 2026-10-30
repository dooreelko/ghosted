// The generate queue: after a successful run, delete the requests that piled up.
import { SQSClient, ReceiveMessageCommand, DeleteMessageBatchCommand } from '@aws-sdk/client-sqs';

export function createQueue({ url, client = new SQSClient({ region: process.env.AWS_REGION }) }) {
  return {
    async drain() {
      let n = 0;
      for (;;) {
        const { Messages = [] } = await client.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 0, VisibilityTimeout: 30 }));
        if (!Messages.length) return n;
        await client.send(new DeleteMessageBatchCommand({ QueueUrl: url, Entries: Messages.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle })) }));
        n += Messages.length;
      }
    },
  };
}
