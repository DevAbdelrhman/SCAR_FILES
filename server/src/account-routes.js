import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import bcrypt from 'bcrypt';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import { db } from './db.js';
import { config } from './config.js';

const router = express.Router();
const idPattern = /^[a-f0-9-]{36}$/i;
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many attempts. Try again later.' } });
const cleanName = (name) => path.posix.basename(String(name).replaceAll('\\\\', '/')).replace(/[\\u0000-\\u001f\\u007f]/g, '').trim().slice(0, 255) || 'unnamed-file';
const publicUser = (u) => ({ id: u.id, username: u.username, email: u.email, createdAt: u.created_at });
const mapFile = (f) => ({ id:f.id, originalName:f.original_name, extension:f.extension, mimeType:f.mime_type, fileSize:f.file_size, uploadedAt:f.uploaded_at, isPublic:Boolean(f.is_public) });
function csrf(req,res,next) {
 const a=req.get('x-csrf-token'), b=req.session?.csrfToken;
 if(!a || !b || a.length!==b.length || !/^[a-f0-9]{64}$/i.test(a) || !crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b))) return res.status(403).json({error:'Security token expired. Refresh and try again.'});
 next();
}
function currentUser(req,res,next) {
 const id=req.session?.userId;
 if(!id) return res.status(401).json({error:'Sign in required.'});
 const u=db.prepare("SELECT id,username,email,status,created_at FROM users WHERE id=?").get(id);
 if(!u || u.status!=='active') { req.session.destroy(()=>{}); return res.status(401).json({error:'Your account is unavailable. Contact support.'}); }
 req.user=u; next();
}
function admin(req,res,next) {
 const id=req.session?.adminId;
 if(!id) return res.status(401).json({error:'Administrator access required.'});
 const a=db.prepare('SELECT id,username FROM admins WHERE id=?').get(id);
 if(!a) return res.status(401).json({error:'Administrator access required.'});
 req.admin=a; next();
}
function storagePath(row) {
 const resolved=path.resolve(row.storage_path), relative=path.relative(config.storageDir,resolved);
 if(!relative || relative.startsWith('..') || path.isAbsolute(relative) || row.stored_name!==path.basename(resolved) || !/^[a-f0-9-]{36}$/i.test(row.stored_name)) return null;
 return resolved;
}
const uploadStorage={
 _handleFile(req,file,cb) {
  const filename=crypto.randomUUID(), target=path.join(config.storageDir,filename); let size=0;
  const stream=file.stream;
  const chunks=[];
  stream.on('data',chunk=>{size+=chunk.length; if(size>config.maxFileBytes) stream.destroy(new multer.MulterError('LIMIT_FILE_SIZE')); else chunks.push(chunk);});
  stream.on('error',err=>{fs.rm(target,{force:true},()=>cb(err));});
  stream.on('end',()=>{try{const fd=fs.openSync(target,'wx',0o600); for(const chunk of chunks) fs.writeSync(fd,chunk); fs.closeSync(fd); cb(null,{destination:config.storageDir,filename,path:target,size});}catch(e){cb(e);}});
 },
 _removeFile(_req,file,cb){fs.rm(file.path,{force:true},cb);}
};
const upload=multer({storage:uploadStorage,limits:{fileSize:config.maxFileBytes,files:config.maxUploadFiles,fields:0,parts:config.maxUploadFiles}}).array('files',config.maxUploadFiles);
function finishLogin(req,res,role,id,details) {
 req.session.regenerate(err=>{
  if(err) return res.status(500).json({error:'Could not start a secure session.'});
  req.session[role==='admin'?'adminId':'userId']=id;
  req.session.csrfToken=crypto.randomBytes(32).toString('hex');
  req.session.save(e=>{if(e)return res.status(500).json({error:'Could not save your session.'}); res.set('Cache-Control','no-store').json({[role]:details,csrfToken:req.session.csrfToken});});
 });
}
router.post('/register',authLimiter,csrf,async(req,res)=>{
 const username=typeof req.body?.username==='string'?req.body.username.trim():'';
 const email=typeof req.body?.email==='string'?req.body.email.trim().toLowerCase():'';
 const password=typeof req.body?.password==='string'?req.body.password:'';
 if(!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) return res.status(400).json({error:'Username must be 3–32 characters and use letters, numbers, dot, dash or underscore.'});
 if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email) || email.length>254) return res.status(400).json({error:'Enter a valid email address.'});
 if(password.length<10 || Buffer.byteLength(password,'utf8')>72) return res.status(400).json({error:'Password must be at least 10 characters and no more than 72 bytes.'});
 try {
  const hash=await bcrypt.hash(password,12);
  const result=db.prepare('INSERT INTO users(username,email,password_hash) VALUES(?,?,?)').run(username,email,hash);
  const user=db.prepare('SELECT id,username,email,created_at FROM users WHERE id=?').get(result.lastInsertRowid);
  finishLogin(req,res,'user',user.id,publicUser(user));
 } catch(e) { if(e.code==='SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({error:'That username or email is already in use.'}); res.status(500).json({error:'Could not create your account.'}); }
});
router.post('/login',authLimiter,csrf,async(req,res)=>{
 const login=typeof req.body?.login==='string'?req.body.login.trim():'';
 const password=typeof req.body?.password==='string'?req.body.password:'';
 const user=db.prepare('SELECT id,username,email,password_hash,status,created_at FROM users WHERE username=? COLLATE NOCASE OR email=? COLLATE NOCASE').get(login,login);
 const hash=user?.password_hash || '$2b$12$C6UzMDM.H6dfI/f/IKcEe.1O6x8K7u2q7Y0zX0yX0yX0yX0yX0yX0';
 const ok=await bcrypt.compare(password,hash).catch(()=>false);
 if(!user || !ok || user.status!=='active') return res.status(401).json({error:'Email/username or password is incorrect.'});
 finishLogin(req,res,'user',user.id,publicUser(user));
});
router.get('/me',currentUser,(req,res)=>res.set('Cache-Control','no-store').json({user:publicUser(req.user)}));
router.post('/logout',currentUser,csrf,(req,res)=>req.session.destroy(err=>{if(err)return res.status(500).json({error:'Could not sign out.'});res.clearCookie('scar.files.sid',{httpOnly:true,secure:config.nodeEnv==='production',sameSite:'lax',path:'/'});res.status(204).end();}));
router.get('/files',(req,res)=>{
 const q=typeof req.query.q==='string'?req.query.q.trim().slice(0,120):'';
 const page=Math.max(1,Math.min(10000,Number.parseInt(req.query.page,10)||1)), size=Math.max(1,Math.min(50,Number.parseInt(req.query.pageSize,10)||20));
 const where=q?"is_public=1 AND original_name LIKE ? ESCAPE '\\\\'":"is_public=1", search=q?'%'+q.replace(/[\\\\%_]/g,'\\\\$&')+'%':null;
 const total=q?db.prepare('SELECT COUNT(*) total FROM files WHERE '+where).get(search).total:db.prepare('SELECT COUNT(*) total FROM files WHERE '+where).get().total;
 const rows=q?db.prepare('SELECT * FROM files WHERE '+where+' ORDER BY uploaded_at DESC LIMIT ? OFFSET ?').all(search,size,(page-1)*size):db.prepare('SELECT * FROM files WHERE '+where+' ORDER BY uploaded_at DESC LIMIT ? OFFSET ?').all(size,(page-1)*size);
 res.set('Cache-Control','no-store').json({files:rows.map(mapFile),total,page,pageSize:size});
});
router.get('/files/:id/download',(req,res)=>{
 if(!idPattern.test(req.params.id)) return res.status(404).json({error:'File not found.'});
 const row=db.prepare('SELECT * FROM files WHERE id=? AND is_public=1').get(req.params.id);
 if(!row) return res.status(404).json({error:'This file is unavailable or private.'});
 const p=storagePath(row); if(!p || !fs.existsSync(p)) return res.status(404).json({error:'File content is unavailable.'});
 res.set({'Content-Type':'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':'public, max-age=60'});
 res.download(p,row.original_name,{headers:{'Content-Type':'application/octet-stream','X-Content-Type-Options':'nosniff'}});
});
router.get('/my/files',currentUser,(req,res)=>{
 const q=typeof req.query.q==='string'?req.query.q.trim().slice(0,120):'';
 const page=Math.max(1,Math.min(10000,Number.parseInt(req.query.page,10)||1)), size=Math.max(1,Math.min(50,Number.parseInt(req.query.pageSize,10)||20));
 const where=q?'owner_user_id=? AND original_name LIKE ? ESCAPE \'\\\\\'':'owner_user_id=?';
 const args=q?[req.user.id,'%'+q.replace(/[\\\\%_]/g,'\\\\$&')+'%']:[req.user.id];
 const total=db.prepare('SELECT COUNT(*) total FROM files WHERE '+where).get(...args).total;
 const rows=db.prepare('SELECT * FROM files WHERE '+where+' ORDER BY uploaded_at DESC LIMIT ? OFFSET ?').all(...args,size,(page-1)*size);
 res.json({files:rows.map(mapFile),total,page,pageSize:size});
});
router.post('/my/files/upload',currentUser,csrf,(req,res,next)=>upload(req,res,err=>{
 if(err) return res.status(err.code==='LIMIT_FILE_SIZE'?413:400).json({error:err.code==='LIMIT_FILE_SIZE'?'A file exceeds the upload size limit.':'Upload could not be processed.'});
 const files=req.files||[]; if(!files.length)return res.status(400).json({error:'Choose at least one file.'});
 const batch=files.reduce((n,f)=>n+f.size,0), used=db.prepare('SELECT COALESCE(SUM(file_size),0) n FROM files WHERE owner_user_id=?').get(req.user.id).n;
 if(batch>config.maxBatchBytes || used+batch>config.maxStorageBytes){files.forEach(f=>fs.rmSync(f.path,{force:true}));return res.status(413).json({error:'Your account storage limit would be exceeded.'});}
 const now=new Date().toISOString();
 const insert=db.prepare('INSERT INTO files(id,original_name,stored_name,extension,mime_type,file_size,storage_path,uploaded_at,is_public,owner_user_id) VALUES(?,?,?,?,?,?,?,?,0,?)');
 try {
  const result=db.transaction(()=>files.map(f=>{const name=cleanName(f.originalname);const id=crypto.randomUUID();insert.run(id,name,path.basename(f.path),path.extname(name).toLowerCase()||'(no extension)','application/octet-stream',f.size,path.resolve(f.path),now,req.user.id);return{id,originalName:name,extension:path.extname(name).toLowerCase()||'(no extension)',mimeType:'application/octet-stream',fileSize:f.size,uploadedAt:now,isPublic:false};}))();
  res.status(201).json({files:result});
 } catch(e){files.forEach(f=>fs.rmSync(f.path,{force:true}));next(e);}
}));
router.get('/my/files/:id/download',currentUser,(req,res)=>{
 if(!idPattern.test(req.params.id))return res.status(404).json({error:'File not found.'});
 const row=db.prepare('SELECT * FROM files WHERE id=? AND owner_user_id=?').get(req.params.id,req.user.id);
 if(!row)return res.status(404).json({error:'File not found.'});
 const p=storagePath(row);if(!p||!fs.existsSync(p))return res.status(404).json({error:'File content is unavailable.'});
 res.set({'Content-Type':'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':'private,no-store'});
 res.download(p,row.original_name,{headers:{'Content-Type':'application/octet-stream','X-Content-Type-Options':'nosniff'}});
});
router.delete('/my/files/:id',currentUser,csrf,(req,res)=>{
 if(!idPattern.test(req.params.id))return res.status(404).json({error:'File not found.'});
 const row=db.prepare('SELECT * FROM files WHERE id=? AND owner_user_id=?').get(req.params.id,req.user.id);
 if(!row)return res.status(404).json({error:'File not found.'});
 const p=storagePath(row);db.prepare('DELETE FROM files WHERE id=? AND owner_user_id=?').run(row.id,req.user.id);if(p)fs.rmSync(p,{force:true});res.status(204).end();
});
router.get('/admin/users',admin,(req,res)=>{
 const rows=db.prepare("SELECT u.id,u.username,u.email,u.status,u.created_at,COUNT(f.id) file_count,COALESCE(SUM(f.file_size),0) storage_used FROM users u LEFT JOIN files f ON f.owner_user_id=u.id GROUP BY u.id ORDER BY u.created_at DESC").all();
 res.json({users:rows});
});
router.patch('/admin/users/:id/status',admin,csrf,(req,res)=>{
 const status=req.body?.status;if(!['active','disabled'].includes(status))return res.status(400).json({error:'Invalid account status.'});
 const result=db.prepare('UPDATE users SET status=?,updated_at=? WHERE id=?').run(status,new Date().toISOString(),Number(req.params.id));
 if(!result.changes)return res.status(404).json({error:'User not found.'});
 if(status==='disabled') db.prepare('DELETE FROM sessions WHERE sid IN (SELECT sid FROM sessions WHERE sess LIKE ?)').run('%"userId":'+Number(req.params.id)+'%');
 res.json({success:true});
});
router.patch('/admin/files/:id/public',admin,csrf,(req,res)=>{
 if(typeof req.body?.isPublic!=='boolean')return res.status(400).json({error:'isPublic must be boolean.'});
 const result=db.prepare('UPDATE files SET is_public=? WHERE id=?').run(req.body.isPublic?1:0,req.params.id);
 if(!result.changes)return res.status(404).json({error:'File not found.'});
 res.json({success:true,isPublic:req.body.isPublic});
});
export default router;
