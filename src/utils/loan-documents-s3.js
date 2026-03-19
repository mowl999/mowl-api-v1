const { Readable } = require("node:stream");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");

function getBucketName() {
  return process.env.AWS_S3_BUCKET_LOAN_DOCS || process.env.AWS_S3_BUCKET || "";
}

function getRegion() {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "";
}

function getS3Client() {
  const region = getRegion();
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

  if (!region || !getBucketName()) return null;

  const options = { region };
  if (accessKeyId && secretAccessKey) {
    options.credentials = { accessKeyId, secretAccessKey };
  }

  return new S3Client(options);
}

function assertStorageConfigured() {
  const client = getS3Client();
  const bucket = getBucketName();
  if (!client || !bucket) {
    const err = new Error("Loan document storage is not configured. Add AWS_REGION and AWS_S3_BUCKET_LOAN_DOCS.");
    err.status = 500;
    err.code = "LOAN_DOCUMENT_STORAGE_NOT_CONFIGURED";
    throw err;
  }
  return { client, bucket };
}

function makeStorageKey({ applicationId, originalName }) {
  const safeName = String(originalName || "document")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-");
  return `loan-applications/${applicationId}/${Date.now()}-${safeName}`;
}

async function uploadLoanDocument({ applicationId, originalName, buffer, mimeType }) {
  const { client, bucket } = assertStorageConfigured();
  const key = makeStorageKey({ applicationId, originalName });
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: mimeType || "application/octet-stream",
    })
  );

  return { bucket, key };
}

async function openLoanDocument({ bucket, key }) {
  const { client } = assertStorageConfigured();
  const out = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );

  return {
    body: Readable.from(out.Body),
    contentType: out.ContentType || "application/octet-stream",
    contentLength: out.ContentLength || null,
  };
}

module.exports = {
  assertStorageConfigured,
  uploadLoanDocument,
  openLoanDocument,
};
