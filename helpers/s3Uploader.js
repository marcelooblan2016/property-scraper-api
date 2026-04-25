'use strict';

/**
 * app/helpers/s3Uploader.js
 *
 * Uploads a local file to S3 then deletes it locally.
 * Used by both type1 (propertyScraper) and type2 (propertyScraperHuman)
 * after a deed PDF is successfully downloaded.
 *
 * Required .env vars:
 *   S3_BUCKET       — bucket name, e.g. "my-deeds-bucket"
 *   S3_REGION       — AWS region, e.g. "us-east-1"
 *   S3_ACCESS_KEY   — AWS access key ID
 *   S3_SECRET_KEY   — AWS secret access key
 *   S3_PREFIX       — optional key prefix/folder, e.g. "deeds" (default: "deeds")
 *
 * S3 key pattern:
 *   <S3_PREFIX>/<propertyId>/<filename>
 *   e.g. deeds/888888/deed.pdf
 *
 * Returns:
 *   { s3Key, s3Url }
 *   s3Url is the public-style URL — only accessible if bucket is public
 *   or you generate a presigned URL separately.
 */

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs   = require('fs');
const path = require('path');

/**
 * Upload a file to S3 and delete it locally.
 *
 * @param {object} options
 * @param {string} options.localPath   — absolute or relative path to local file
 * @param {string} options.propertyId  — used to build the S3 key
 * @returns {Promise<{ s3Key: string, s3Url: string }>}
 */
async function uploadToS3({ localPath, propertyId, prefix = 'property-scraper-api' }) {
    const bucket   = process.env.S3_BUCKET;
    const region   = process.env.S3_REGION;
    const accessKey = process.env.S3_ACCESS_KEY;
    const secretKey = process.env.S3_SECRET_KEY;

    if (!bucket || !region || !accessKey || !secretKey) {
        throw new Error('[s3] Missing required env vars: S3_BUCKET, S3_REGION, S3_ACCESS_KEY, S3_SECRET_KEY');
    }

    const client = new S3Client({
        region,
        credentials: {
            accessKeyId:     accessKey,
            secretAccessKey: secretKey,
        },
    });

    const filename  = path.basename(localPath);
    const s3Key     = `${prefix}/${propertyId}/${filename}`;
    const fileBuffer = await fs.promises.readFile(localPath);
    const mimeType  = localPath.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream';

    console.log(`[s3] uploading ${localPath} → s3://${bucket}/${s3Key}`);

    await client.send(new PutObjectCommand({
        Bucket:      bucket,
        Key:         s3Key,
        Body:        fileBuffer,
        ContentType: mimeType,
    }));

    // Delete local file after successful upload
    await fs.promises.unlink(localPath);
    console.log(`[s3] local file deleted: ${localPath}`);

    // Also remove the directory if it's now empty
    const dir = path.dirname(localPath);
    const remaining = await fs.promises.readdir(dir);
    if (remaining.length === 0) {
        await fs.promises.rmdir(dir);
        console.log(`[s3] empty directory removed: ${dir}`);
    }

    const s3Url = `https://${bucket}.s3.${region}.amazonaws.com/${s3Key}`;
    console.log(`[s3] upload complete: ${s3Url}`);

    return { s3Key, s3Url };
}

module.exports = { uploadToS3 };