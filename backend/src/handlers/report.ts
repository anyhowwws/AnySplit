import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { errorFields, log } from '../lib/log.ts';
import { readUserCount } from '../lib/usercount.ts';

/**
 * EventBridge-triggered, once a day at 22:00 Singapore time. Reads counts back
 * out of the metrics monitoring.tf already derives from the structured logs —
 * no new storage — and mails a short digest through SNS.
 *
 * The digest is a funnel, in the order a receipt travels: submitted, sent to
 * the model, read, failed, split. Read top to bottom, the gaps between adjacent
 * lines are where people are dropping out, which is the question the report
 * exists to answer. Every line is a count of events in the last 24 hours except
 * the last, which is cumulative.
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

/**
 * Singapore time, as a plain YYYY-MM-DD.
 *
 * SGT is a fixed UTC+8 with no daylight saving, so shifting the instant and
 * reading the UTC date off it is exact — and needs no timezone database in the
 * bundle. The report is a Singapore artefact for a Singapore bot; a UTC date on
 * it was only ever an implementation detail leaking into someone's inbox.
 */
function singaporeDate(at: Date): string {
  return new Date(at.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

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

  const end = new Date();
  const dayStart = new Date(end.getTime() - 24 * 3600 * 1000);

  try {
    const [
      receiptsSubmitted,
      visionCalls,
      receiptsParsed,
      parseFailures,
      splitsFinalised,
      newUsers,
      totalUsers,
    ] = await Promise.all([
      sumMetric(ANYSPLIT, 'BillsStarted', [], dayStart, end),
      sumMetric(ANYSPLIT, 'VisionCalls', [], dayStart, end),
      sumMetric(ANYSPLIT, 'ReceiptsParsed', [], dayStart, end),
      sumMetric(ANYSPLIT, 'ParseFailures', [], dayStart, end),
      sumMetric(ANYSPLIT, 'BillsFinalised', [], dayStart, end),
      sumMetric(ANYSPLIT, 'NewUsers', [], dayStart, end),
      readUserCount(),
    ]);

    // Title Case throughout, and padded here rather than by hand so a label can
    // be reworded without re-aligning the whole block.
    const rows: [string, number][] = [
      ['Receipts Submitted', receiptsSubmitted],
      ['Vision Calls', visionCalls],
      ['Receipts Parsed', receiptsParsed],
      ['Parse Failures', parseFailures],
      ['Splits Finalised', splitsFinalised],
      ['New Users Today', newUsers],
      ['Total Unique Users', totalUsers],
    ];
    const width = Math.max(...rows.map(([label]) => label.length)) + 2;

    const dateLabel = singaporeDate(end);
    const message = [
      `AnySplit — daily report for ${dateLabel} (last 24 hours)`,
      '',
      ...rows.map(([label, value]) => `${`${label}:`.padEnd(width)}${value}`),
    ].join('\n');

    await sns.send(
      new PublishCommand({
        TopicArn: topicArn,
        Subject: `AnySplit daily report — ${dateLabel}`,
        Message: message,
      }),
    );

    log.info('daily report sent', {
      receiptsSubmitted,
      visionCalls,
      receiptsParsed,
      parseFailures,
      splitsFinalised,
      newUsers,
      totalUsers,
    });
  } catch (err) {
    log.error('daily report failed', errorFields(err));
    throw err;
  }
}
