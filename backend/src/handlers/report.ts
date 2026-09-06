import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { errorFields, log } from '../lib/log.ts';
import { readUserCount } from '../lib/usercount.ts';

/**
 * EventBridge-triggered, once a day. Reads counts back out of the metrics
 * monitoring.tf already derives from the structured logs — no new storage —
 * and mails a short digest through SNS.
 *
 * Nothing here can read a bill or touch the bot token. Beyond
 * cloudwatch:GetMetricData and sns:Publish it holds exactly one DynamoDB
 * permission: GetItem on the single `meta#users` counter, pinned to that key by
 * a `dynamodb:LeadingKeys` condition, so a bug in this Lambda still cannot
 * reach a bill. See infra/report.tf.
 *
 * The daily counts come from the metrics; the running user total comes from the
 * table, because a metric filter cannot see anything logged before it existed
 * and so undercounts every user from before it was deployed. usercount.ts has
 * the long version.
 */

const cloudwatch = new CloudWatchClient({});
const sns = new SNSClient({});

const ANYSPLIT = 'AnySplit';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

async function sumMetric(
  namespace: string,
  metricName: string,
  dimensions: { Name: string; Value: string }[],
  start: Date,
  end: Date,
): Promise<number> {
  const periodSeconds = Math.max(60, Math.round((end.getTime() - start.getTime()) / 1000));
  const result = await cloudwatch.send(
    new GetMetricDataCommand({
      StartTime: start,
      EndTime: end,
      // One query, one period spanning the whole window, so CloudWatch hands
      // back a single number rather than a series we'd have to add up.
      MetricDataQueries: [
        {
          Id: 'm',
          MetricStat: {
            Metric: { Namespace: namespace, MetricName: metricName, Dimensions: dimensions },
            Period: periodSeconds,
            Stat: 'Sum',
          },
        },
      ],
    }),
  );
  return result.MetricDataResults?.[0]?.Values?.[0] ?? 0;
}

export async function handler(): Promise<void> {
  const topicArn = required('REPORTS_TOPIC_ARN');
  const httpApiId = required('HTTP_API_ID');

  const end = new Date();
  const dayStart = new Date(end.getTime() - 24 * 3600 * 1000);

  try {
    const [apiCalls, visionCalls, receiptsParsed, billsFinalised, newUsers, totalUsers] =
      await Promise.all([
        sumMetric('AWS/ApiGateway', 'Count', [{ Name: 'ApiId', Value: httpApiId }], dayStart, end),
        sumMetric(ANYSPLIT, 'VisionCalls', [], dayStart, end),
        sumMetric(ANYSPLIT, 'ReceiptsParsed', [], dayStart, end),
        sumMetric(ANYSPLIT, 'BillsFinalised', [], dayStart, end),
        sumMetric(ANYSPLIT, 'NewUsers', [], dayStart, end),
        readUserCount(),
      ]);

    const dateLabel = end.toISOString().slice(0, 10);
    const message = [
      `AnySplit — daily report for ${dateLabel} (last 24h, UTC)`,
      '',
      `API calls:          ${apiCalls}`,
      `Parses attempted:   ${visionCalls}`,
      `Parses succeeded:   ${receiptsParsed}`,
      `Splits finalised:   ${billsFinalised}`,
      `New users:          ${newUsers}`,
      `Total unique users: ${totalUsers}`,
    ].join('\n');

    await sns.send(
      new PublishCommand({
        TopicArn: topicArn,
        Subject: `AnySplit daily report — ${dateLabel}`,
        Message: message,
      }),
    );

    log.info('daily report sent', { apiCalls, visionCalls, receiptsParsed, billsFinalised, newUsers, totalUsers });
  } catch (err) {
    log.error('daily report failed', errorFields(err));
    throw err;
  }
}
