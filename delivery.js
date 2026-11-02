import crypto from 'node:crypto';
import {notificationSafe} from './notifications.js';
import {S3Client,PutObjectCommand,GetObjectCommand,HeadObjectCommand,DeleteObjectCommand} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';

const envKeys=['S3_ENDPOINT','S3_REGION','S3_BUCKET','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY'];
const configured=()=>envKeys.every(k=>!!process.env[k])&&/^https:\/\//.test(process.env.S3_ENDPOINT||'');
const slug=x=>typeof x==='string'&&/^[a-z0-9-]{2,100}$/.test(x);
const version=x=>typeof x==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,49}$/.test(x);
const filename=x=>typeof x==='string'&&/^[-a-zA-Z0-9_. ]{1,150}\.zip$/i.test(x);
const integer=x=>typeof x==='string'&&/^[1-9]\d*$/.test(x);
const checksum=x=>Buffer.from(x,'hex').toString('base64');
const storage=()=>new S3Client({region:process.env.S3_REGION,endpoint:process.env.S3_ENDPOINT,forcePathStyle:true,credentials:{accessKeyId:process.env.S3_ACCESS_KEY_ID,secretAccessKey:process.env.S3_SECRET_ACCESS_KEY}});
const failure=(res,error,status=503)=>res.status(status).json({error});
const safeName=x=>x.replace(/[^a-zA-Z0-9._-]/g,'_');

export async function installDelivery(app,pool,customerAuth){
for(const sql of [
"ALTER TABLE studio_release_files ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true",
"ALTER TABLE studio_release_files ADD COLUMN IF NOT EXISTS file_size BIGINT",
"ALTER TABLE studio_release_files ADD COLUMN IF NOT EXISTS checksum_sha256 TEXT",
"CREATE TABLE IF NOT EXISTS studio_upload_intents (object_key TEXT PRIMARY KEY,product_slug TEXT NOT NULL,version TEXT NOT NULL,filename TEXT NOT NULL,file_size BIGINT NOT NULL,sha256 TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '20 minutes')",
"CREATE UNIQUE INDEX IF NOT EXISTS studio_release_version_unique ON studio_release_files(product_slug,version)"
])await pool.query(sql);

app.get('/api/admin/storage-status',(_q,res)=>res.json({configured:configured(),provider:'S3-compatible private bucket'}));
app.get('/api/admin/releases',async(_q,res)=>{try{res.json((await pool.query("SELECT id,product_slug,version,filename,file_size,active,created_at FROM studio_release_files ORDER BY created_at DESC,id DESC LIMIT 250")).rows)}catch{return failure(res,'Could not list releases')}});

app.post('/api/admin/release-upload',async(req,res)=>{
if(!configured())return failure(res,'Private object storage is not configured');
const {product_slug,version:ver,filename:file,file_size,size,sha256}=req.body||{};
const bytes=file_size??size;
if(!slug(product_slug)||!version(ver)||!filename(file)||!Number.isInteger(bytes)||bytes<1||bytes>250*1024*1024||typeof sha256!=='string'||!/^[a-f0-9]{64}$/i.test(sha256))return failure(res,'Invalid release metadata',400);
try{
const exists=await pool.query('SELECT 1 FROM studio_release_files WHERE product_slug=$1 AND version=$2',[product_slug,ver]);
if(exists.rowCount)return failure(res,'That product version already exists',409);
const key='releases/'+product_slug+'/'+crypto.randomUUID()+'.zip';
await pool.query('INSERT INTO studio_upload_intents(object_key,product_slug,version,filename,file_size,sha256) VALUES($1,$2,$3,$4,$5,$6)',[key,product_slug,ver,file,bytes,sha256.toLowerCase()]);
const sum=checksum(sha256);
const url=await getSignedUrl(storage(),new PutObjectCommand({Bucket:process.env.S3_BUCKET,Key:key,ContentType:'application/zip',ChecksumSHA256:sum}),{expiresIn:600});
res.json({url,key,expires_in:600,checksum_sha256_base64:sum});
}catch(e){console.error('Upload setup failed',e.message);return failure(res,'Could not prepare secure upload')}
});

app.post('/api/admin/release-confirm',async(req,res)=>{
if(!configured())return failure(res,'Storage not configured');
const {key}=req.body||{};
if(typeof key!=='string'||!/^releases\/[a-z0-9-]{2,100}\/[a-f0-9-]{36}\.zip$/.test(key))return failure(res,'Invalid upload key',400);
try{
const pending=await pool.query('SELECT * FROM studio_upload_intents WHERE object_key=$1 AND expires_at>now()',[key]);if(!pending.rowCount)return failure(res,'Upload request expired or unrecognised',403);
const p=pending.rows[0];
const head=await storage().send(new HeadObjectCommand({Bucket:process.env.S3_BUCKET,Key:key}));
if(Number(head.ContentLength)!==Number(p.file_size)||head.ChecksumSHA256!==checksum(p.sha256))return failure(res,'Uploaded file size or checksum does not match',409);
const conn=await pool.connect();
try{await conn.query('BEGIN');
const r=await conn.query('INSERT INTO studio_release_files(product_slug,version,filename,object_key,file_size,checksum_sha256) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[p.product_slug,p.version,p.filename,key,p.file_size,p.sha256]);
await conn.query('INSERT INTO studio_download_grants(entitlement_id,release_id) SELECT e.id,$1 FROM studio_entitlements e JOIN studio_payments pay ON pay.id=e.payment_id WHERE e.product_slug=$2 AND e.revoked_at IS NULL AND pay.status=\'paid\' ON CONFLICT DO NOTHING',[r.rows[0].id,p.product_slug]);
await conn.query('DELETE FROM studio_upload_intents WHERE object_key=$1',[key]);
await conn.query('COMMIT');
const owners=await pool.query('SELECT DISTINCT account_id FROM studio_entitlements WHERE product_slug=$1 AND revoked_at IS NULL',[p.product_slug]);for(const owner of owners.rows)notificationSafe(pool,owner.account_id,'Software update: '+p.product_slug+' '+p.version,'A new version is available in your Codeful Studios account: '+(process.env.PUBLIC_BASE_URL||'https://codefuldesign.onrender.com')+'/account');res.status(201).json({id:r.rows[0].id,product_slug:p.product_slug,version:p.version});
}catch(e){await conn.query('ROLLBACK');throw e}finally{conn.release()}
}catch(e){console.error('Release confirmation failed',e.message);return failure(res,'Release verification failed or version already registered')}
});

app.patch('/api/admin/releases/:id',async(req,res)=>{
if(!integer(req.params.id)||typeof req.body?.active!=='boolean')return failure(res,'Invalid request',400);
try{const r=await pool.query('UPDATE studio_release_files SET active=$1 WHERE id=$2 RETURNING id,active',[req.body.active,req.params.id]);if(!r.rowCount)return failure(res,'Release not found',404);res.json(r.rows[0])}catch{return failure(res,'Could not update release')}
});
app.patch('/api/admin/download-grants/:id',async(req,res)=>{
const limit=req.body?.download_limit;if(!integer(req.params.id)||!Number.isInteger(limit)||limit<0||limit>1000)return failure(res,'Limit must be between 0 and 1000',400);
try{const r=await pool.query('UPDATE studio_download_grants SET download_limit=$1 WHERE id=$2 RETURNING id,download_count,download_limit',[limit,req.params.id]);if(!r.rowCount)return failure(res,'Grant not found',404);res.json(r.rows[0])}catch{return failure(res,'Unable to change limit')}
});
app.get('/api/admin/download-grants',async(req,res)=>{try{res.json((await pool.query('SELECT g.id,g.download_count,g.download_limit,e.account_id,e.product_slug,f.version,f.filename FROM studio_download_grants g JOIN studio_entitlements e ON e.id=g.entitlement_id JOIN studio_release_files f ON f.id=g.release_id ORDER BY g.id DESC LIMIT 250')).rows)}catch{return failure(res,'Unable to list grants')}});

app.post('/api/account/download-file/:id',customerAuth,async(req,res)=>{
if(!configured())return failure(res,'Private storage not configured');
if(!integer(req.params.id))return failure(res,'Invalid release ID',400);
const conn=await pool.connect();let inTx=false;
try{await conn.query('BEGIN');inTx=true;
const r=await conn.query("SELECT g.id,g.download_count,g.download_limit,f.object_key,f.filename FROM studio_download_grants g JOIN studio_entitlements e ON e.id=g.entitlement_id JOIN studio_payments pay ON pay.id=e.payment_id JOIN studio_release_files f ON f.id=g.release_id WHERE f.id=$1 AND e.account_id=$2 AND e.revoked_at IS NULL AND pay.status='paid' AND f.active=true AND g.download_count<g.download_limit ORDER BY g.id LIMIT 1 FOR UPDATE OF g",[req.params.id,req.customer.id]);
if(!r.rowCount){await conn.query('ROLLBACK');inTx=false;return failure(res,'No active entitlement, release unavailable or limit reached',403)}
const grant=r.rows[0];
await storage().send(new HeadObjectCommand({Bucket:process.env.S3_BUCKET,Key:grant.object_key}));
const url=await getSignedUrl(storage(),new GetObjectCommand({Bucket:process.env.S3_BUCKET,Key:grant.object_key,ResponseContentDisposition:'attachment; filename="'+safeName(grant.filename)+'"'}),{expiresIn:120});
await conn.query('UPDATE studio_download_grants SET download_count=download_count+1 WHERE id=$1',[grant.id]);await conn.query('COMMIT');inTx=false;
res.json({url,expires_in:120,remaining:grant.download_limit-grant.download_count-1});
}catch(e){if(inTx)await conn.query('ROLLBACK');console.error('Download failed',e.message);return failure(res,'Download unavailable; your allowance has not been charged')}finally{conn.release()}
});
}
