// Ghost scheduling adapter backed by EventBridge Scheduler: a scheduled post becomes a
// one-shot schedule that invokes the scheduled-publish function at its time. The queue is
// persistent, so nothing is rebuilt on boot. Ghost loads this file from its content path.
const crypto = require('node:crypto');
const path = require('node:path');
const { createRequire } = require('node:module');
const { SchedulerClient, CreateScheduleCommand, UpdateScheduleCommand, DeleteScheduleCommand, ConflictException, ResourceNotFoundException } = require('@aws-sdk/client-scheduler');

const ghostRequire = createRequire(path.join(process.env.GHOST_ROOT ?? '/var/task', 'core', 'x.js'));
const { SchedulingBase } = ghostRequire('@tryghost/adapter-base-scheduling');

const GROUP = 'ghost-phase3';
// EventBridge Scheduler works to the minute and wants a time in the future.
const MIN_LEAD_MS = 60_000;

// One schedule per callback path (a post, a page, the automations poll): the token in the
// query changes with every signing, the path does not.
function scheduleName(job) {
  const u = new URL(job.url);
  return `ghost-${crypto.createHash('sha1').update(u.origin + u.pathname).digest('hex')}`;
}

module.exports = class SchedulingEventBridge extends SchedulingBase {
  rescheduleOnBoot = false;
  dedupesByIdempotencyKey = false;

  constructor(options = {}) {
    super();
    this.scheduler = options.scheduler ?? new SchedulerClient({ region: process.env.AWS_REGION });
    this.targetName = options.targetName ?? process.env.SCHEDULED_PUBLISH_FUNCTION;
    this.roleArn = options.roleArn ?? process.env.SCHEDULER_ROLE_ARN;
  }

  run() {}

  async schedule(job) {
    const when = new Date(Math.max(job.time, Date.now() + MIN_LEAD_MS));
    const input = JSON.stringify({ url: job.url, method: job.extra?.httpMethod ?? 'PUT' });
    const params = {
      Name: scheduleName(job),
      GroupName: GROUP,
      ScheduleExpression: `at(${when.toISOString().slice(0, 19)})`,
      ScheduleExpressionTimezone: 'UTC',
      FlexibleTimeWindow: { Mode: 'OFF' },
      ActionAfterCompletion: 'DELETE',
      // A failing callback is retried a few times, not for a day (the default).
      Target: { Arn: await this._targetArn(), RoleArn: this.roleArn, Input: input, RetryPolicy: { MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 3600 } },
    };
    try {
      await this.scheduler.send(new CreateScheduleCommand(params));
    } catch (err) {
      if (!(err instanceof ConflictException)) throw err;
      await this.scheduler.send(new UpdateScheduleCommand(params)); // rescheduled: same path, new time
    }
  }

  async unschedule(job) {
    try {
      await this.scheduler.send(new DeleteScheduleCommand({ Name: scheduleName(job), GroupName: GROUP }));
    } catch (err) {
      if (!(err instanceof ResourceNotFoundException)) throw err;
    }
  }

  async _targetArn() {
    // Same account and region as the scheduler role; the target by name.
    const account = this.roleArn.split(':')[4];
    return `arn:aws:lambda:${process.env.AWS_REGION}:${account}:function:${this.targetName}`;
  }
};
