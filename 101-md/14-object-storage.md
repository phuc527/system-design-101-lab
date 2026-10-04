# 14 — Object Storage

> Don't put files in your database or on your API server's disk. Put them in object storage (S3, GCS, Azure Blob, MinIO) and store only the key.

---

## 1. The problem

Users upload avatars, videos, PDFs.

| Where | Problem |
|---|---|
| **Database BLOB** | bloats DB, slows backups/replication, expensive storage, buffer cache wasted on bytes |
| **API server local disk** | with 3 instances behind an LB, the file exists only on one; lost when the container dies |
| **Shared NFS** | SPOF, hard to scale, POSIX locking overhead |
| **Streaming through the API** | 2 GB upload ties up Node process memory, bandwidth and event loop |

**Object storage** stores **objects** (bytes + metadata) in **buckets**, accessed by **key** over HTTP. It's virtually unlimited, highly durable (S3: 11 nines), and cheap.

---

## 2. Object vs block vs file storage

| | Block (EBS, disks) | File (NFS, EFS) | Object (S3) |
|---|---|---|---|
| Unit | fixed-size blocks | files in directory tree | objects in flat namespace |
| Access | mounted disk | POSIX filesystem | HTTP API (PUT/GET/DELETE) |
| Modify | in place, byte-level | in place | replace whole object |
| Scale | one machine | moderate | effectively unlimited |
| Latency | lowest (µs–ms) | low | higher (10–100 ms) |
| Use | databases, OS | shared config, legacy apps | media, backups, logs, data lakes, static sites |

---

## 3. Core concepts

```text
bucket: my-app-uploads
 ├─ users/42/avatar.webp
 ├─ users/42/docs/2026/invoice-991.pdf
 └─ videos/abc123/master.mp4
```

- **Bucket** — top-level container (region, policies, versioning)
- **Key** — the full "path" string; folders are an illusion (prefixes + `/` delimiter)
- **Object** — data + metadata (`Content-Type`, `Cache-Control`, custom `x-amz-meta-*`)
- **Immutable-ish** — you overwrite whole objects; no append/partial update
- **Consistency** — S3 provides strong read-after-write consistency (since 2020)
- **Durability** — data replicated/erasure-coded across devices and AZs

---

## 4. Presigned URLs — keep bytes off your servers

```text
1. client → API:  "I want to upload avatar.png (image/png, 2 MB)"
2. API checks auth, validates type/size, generates key, signs a PUT URL (expires in 5 min)
3. API → client:  { uploadUrl, key }
4. client ──PUT bytes──▶ S3 directly            (API never touches the file)
5. client → API:  "done, key = users/42/avatar-uuid.png"   (or S3 event notification)
6. API verifies object exists (HEAD), saves key in DB
```

Downloads work the same way: presigned GET URL for private objects, valid for minutes.

```ts
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({
  region: "us-east-1",
  endpoint: process.env.S3_ENDPOINT,   // e.g. http://minio:9000 locally
  forcePathStyle: true,                // needed for MinIO
});

app.post("/uploads", requireAuth, async (req, res) => {
  const { contentType, size } = req.body;
  if (!["image/png", "image/jpeg", "image/webp"].includes(contentType)) return res.status(400).end();
  if (size > 5 * 1024 * 1024) return res.status(413).end();

  const key = `users/${req.user.id}/${crypto.randomUUID()}`;
  const url = await getSignedUrl(s3,
    new PutObjectCommand({ Bucket: "uploads", Key: key, ContentType: contentType }),
    { expiresIn: 300 });
  res.json({ url, key });
});

app.get("/files/:id", requireAuth, async (req, res) => {
  const file = await db.files.findOwned(req.params.id, req.user.id);   // authorization!
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: "uploads", Key: file.key }), { expiresIn: 60 });
  res.redirect(url);
});
```

⚠ A presigned PUT doesn't strictly enforce size by itself — use **presigned POST** with a `content-length-range` condition, or validate after upload and delete violators.

---

## 5. Multipart upload — large files

Single PUT is limited (S3: 5 GB) and one network glitch restarts everything.

**Multipart:**
1. `CreateMultipartUpload` → `uploadId`
2. Split file into parts (5 MB – 5 GB each, up to 10,000 parts); upload parts **in parallel**, each with its own presigned URL
3. Retry only failed parts
4. `CompleteMultipartUpload` with the list of part ETags → S3 assembles the object

✅ parallelism (faster), resumability, files up to 5 TB
⚠ set a lifecycle rule to **abort incomplete multipart uploads** after N days — orphaned parts are billed

Node: `@aws-sdk/lib-storage` `Upload` class handles multipart automatically for server-side uploads.

---

## 6. Serving files

```text
user ──▶ CDN ──(miss)──▶ bucket (private, CDN-only access via OAC/OAI)
```

- Put a **CDN** in front for public content (guide 13); keep the bucket private and allow only the CDN
- Set `Cache-Control` and `Content-Type` on upload
- **Never** serve user uploads from your main domain without care — uploaded HTML/SVG can run scripts (XSS). Use a separate domain and `Content-Disposition: attachment` for untrusted types

---

## 7. Processing pipeline

```text
upload complete ─▶ S3 event ─▶ queue ─▶ worker: virus scan, validate, resize/transcode, extract metadata
                                         └─▶ write variants (thumb, 720p) ─▶ update DB status "ready"
```

The DB row tracks status (`pending → processing → ready / rejected`). The client polls or gets a WebSocket event.

---

## 8. Data management features

| Feature | Use |
|---|---|
| **Versioning** | recover overwritten/deleted objects |
| **Lifecycle rules** | move to cheaper tiers (Infrequent Access, Glacier) after N days; expire temp files |
| **Storage classes** | trade retrieval latency/cost for storage price |
| **Replication** (cross-region) | DR, latency |
| **Object Lock / WORM** | compliance, ransomware protection |
| **Encryption** | SSE-S3 / SSE-KMS at rest; TLS in transit |
| **Event notifications** | trigger processing |

---

## 9. Key design

- Include tenant/user for access control and listing: `tenants/{t}/users/{u}/...`
- Use **random IDs**, never user-supplied file names as keys (path traversal, collisions, enumeration)
- Keep the original filename in DB/metadata for display
- Store `key`, `size`, `contentType`, `checksum`, `status` in your DB — the DB is the index, bucket is the bytes

---

## 10. Security checklist

- [ ] Buckets private by default (block public access)
- [ ] Short-lived presigned URLs, generated only after authorization
- [ ] Validate type (magic bytes, not just extension) and size
- [ ] Malware scanning for user uploads
- [ ] Separate domain / `Content-Disposition` for untrusted content
- [ ] Least-privilege IAM for app (only its bucket/prefix)
- [ ] Encryption at rest, access logging

---

## 11. Trade-offs

| Gain | Cost |
|---|---|
| unlimited, durable, cheap | higher latency than disk |
| offloads bandwidth from API | no partial updates / appends |
| scales with zero ops | eventual design: DB and bucket can disagree (orphans) → reconciliation jobs |
| | egress costs can surprise you → CDN |

---

## 12. Interview questions

1. **Why not store images in the database?** — Bloats DB, slows backups and replication, wastes cache; object storage is cheaper and scales.
2. **What is a presigned URL?** — Time-limited, signed URL granting a specific operation on one object without exposing credentials.
3. **How do you upload a 10 GB file reliably?** — Multipart upload, parallel parts, retry per part, complete; lifecycle-abort orphans.
4. **How do you serve private files?** — Authorize in API, return a short-lived presigned GET (or signed CDN URL).
5. **Block vs file vs object storage?** — Disk blocks vs POSIX files vs HTTP-accessed objects in flat namespace.
6. **Design an image upload + thumbnail service.** — Presigned upload → S3 event → queue → worker resizes → variants to S3 → DB status → CDN.

**Prev:** [13 — CDN](13-cdn.md) · **Next:** [15 — API Gateway](15-api-gateway.md)
