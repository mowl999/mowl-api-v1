# Render deployment guidance for MyLoan reminders

This project supports two production-safe ways to run the MyLoan reminder job.

## Recommended: Render Cron Job

Use a Render Cron Job to run:

```bash
npm run loan-reminders:run
```

Recommended schedule:

- every hour for upcoming and overdue loan reminders

Why this is the preferred setup:

- the process runs, sends reminders, and exits cleanly
- the public web service is not responsible for background timing
- reminder execution stays predictable even if the web service scales

Suggested Cron Job settings:

- Build Command: `npm install && npx prisma generate`
- Start Command: `npm run loan-reminders:run`
- Reuse the same environment variables as the API service

Required env vars for the cron job:

- `DATABASE_URL`
- `FRONTEND_APP_URL`
- `EMAIL_FROM`
- `RESEND_API_KEY` or SMTP settings
- `SUPPORT_EMAIL`
- `LOAN_REMINDER_UPCOMING_DAYS`

These env values now act as safe defaults. Admin-configurable MyLoan reminder settings in the console override the reminder lead time, repeat cadence, and channel toggles once the database is available.

## Alternative: in-process scheduler

The API also supports an internal interval scheduler in `src/index.js`.

To enable it:

- set `ENABLE_LOAN_REMINDER_JOBS=true`
- set `LOAN_REMINDER_INTERVAL_MINUTES` to the interval you want

Use this only when you are sure the API runs on a single instance. If the web service scales horizontally, each instance can try to run the scheduler.

## Production recommendation

For Render production:

1. keep `ENABLE_LOAN_REMINDER_JOBS=false` on the web service
2. create a dedicated Render Cron Job
3. run `npm run loan-reminders:run` on the schedule you want

## Helpful links

- Render docs overview: https://render.com/docs
- Render service types: https://render.com/docs/service-types
- Render one-off jobs: https://render.com/docs/one-off-jobs
- Render Blueprints (IaC): https://render.com/docs/infrastructure-as-code
