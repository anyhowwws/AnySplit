import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { errorFields, log } from '../lib/log.ts';

/**
 * EventBridge-triggered, once a day. Reads counts back out of the metrics
 * monitoring.tf already derives from the structured logs — no new storage —
 * and mails a short digest through SNS.
 *
 * Nothing here touches the bills table or the bot token: this Lambda only
 * needs cloudwatch:GetMetricData and sns:Publish, so a bug in it cannot affect
 * the bot or read anything about a bill. See infra/report.tf.
 */

const cloudwatch = new CloudWatchClient({});
const sns = new SNSClient({});

const ANYSPLIT = 'AnySplit';

/** CloudWatch keeps daily-period data for about 15 months. Stay under that. */
const LOOKBACK_DAYS = 450;

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
  const everStart = new Date(end.getTime() - LOOKBACK_DAYS * 24 * 3600 * 1000);

  try {
    const [apiCalls, visionCalls, receiptsParsed, billsFinalised, newUsers, totalUsers] =
      await Promise.all([
        sumMetric('AWS/ApiGateway', 'Count', [{ Name: 'ApiId', Value: httpApiId }], dayStart, end),
        sumMetric(ANYSPLIT, 'VisionCalls', [], dayStart, end),
        sumMetric(ANYSPLIT, 'ReceiptsParsed', [], dayStart, end),
        sumMetric(ANYSPLIT, 'BillsFinalised', [], dayStart, end),
        sumMetric(ANYSPLIT, 'NewUsers', [], dayStart, end),
        sumMetric(ANYSPLIT, 'NewUsers', [], everStart, end),
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
