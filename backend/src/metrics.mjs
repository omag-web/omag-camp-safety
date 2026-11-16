// Custom CloudWatch metrics (namespace "Ranger"), written as Embedded Metric Format log lines.
// CloudWatch turns them into metrics automatically; the alarms in template.yaml watch them.
//   GlobalLimitReached  the daily question limit for everyone was hit
//   PersonLimitReached  one person hit their daily limit
//   ModelFallback       the main model failed and Ranger used the backup model
//   TimeBudgetReached   an answer stopped researching early to finish in time

export function metric(name, value = 1) {
  if (!process.env.AWS_LAMBDA_FUNCTION_NAME) return;   // only in Lambda
  console.log(JSON.stringify({
    _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: 'Ranger', Dimensions: [[]], Metrics: [{ Name: name, Unit: 'Count' }] }] },
    [name]: value
  }));
}
