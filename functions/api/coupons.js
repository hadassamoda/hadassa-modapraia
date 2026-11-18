const headers={"content-type":"application/json; charset=utf-8","cache-control":"no-store"};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers});
const enc=new TextEncoder();
const b64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=/g,"").replace(/\\+/g,"-").replace(/\\//g,"_");
async function sign(secret,value){const key=await crypto.subtle.importKey("raw",enc.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);return b64(await crypto.subtle.sign("HMAC",key,enc.encode(value)));}
async function authorized(request,secret){const raw=request.headers.get("authorization")||"";const parts=raw.replace(/^Bearer\\s+/i,"").split(".");if(parts.length!==2)return false;if(await sign(secret,parts[0])!==parts[1])return false;try{return JSON.parse(atob(parts[0].replace(/-/g,"+").replace(/_/g,"/"))).exp>Date.now();}catch{return false;}}
const clean=(v,max=120)=>String(v??"").trim().slice(0,max);
async function ensureTables(db){
 await db.prepare("CREATE TABLE IF NOT EXISTS coupons (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE COLLATE NOCASE, discount_type TEXT NOT NULL CHECK(discount_type IN ('percent','fixed')), discount_value INTEGER NOT NULL, min_subtotal_cents INTEGER NOT NULL DEFAULT 0, max_uses INTEGER, used_count INTEGER NOT NULL DEFAULT 0, starts_at TEXT, expires_at TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
 await db.prepare("CREATE TABLE IF NOT EXISTS order_coupon_redemptions (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, coupon_id INTEGER NOT NULL, code TEXT NOT NULL, discount_cents INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
}
function couponState(c,subtotal){
 const now=Date.now();
 if(!c.active)return "Este cupom não está ativo.";
 if(c.starts_at&&Date.parse(c.starts_at.replace(" ","T")+"Z")>now)return "Este cupom ainda não começou.";
 if(c.expires_at&&Date.parse(c.expires_at.replace(" ","T")+"Z")<now)return "Este cupom expirou.";
 if(c.max_uses!==null&&Number(c.used_count)>=Number(c.max_uses))return "Este cupom atingiu o limite de utilizações.";
 if(subtotal<Number(c.min_subtotal_cents||0))return "O pedido mínimo para este cupom é R$ "+(Number(c.min_subtotal_cents)/100).toFixed(2).replace(".",",")+".";
 return "";
}
function discountFor(c,subtotal){return Math.min(subtotal,c.discount_type==="percent"?Math.floor(subtotal*Math.min(90,Number(c.discount_value))/100):Number(c.discount_value));}
export async function onRequest({request,env}){
 try{
  if(!env.DB)return json({error:"Banco de dados não configurado."},503);
  await ensureTables(env.DB);
  const url=new URL(request.url),action=url.searchParams.get("action")||"";
  if(request.method==="POST"&&action==="validate"){
   let b;try{b=await request.json();}catch{return json({error:"Dados inválidos."},400);}
   const code=clean(b.code,40).toUpperCase(),subtotal=Number(b.subtotal_cents);
   if(!code||!Number.isSafeInteger(subtotal)||subtotal<0)return json({error:"Informe um cupom e um subtotal válido."},400);
   const c=await env.DB.prepare("SELECT * FROM coupons WHERE code=? COLLATE NOCASE").bind(code).first();
   if(!c)return json({error:"Cupom não encontrado."},404);
   const problem=couponState(c,subtotal);if(problem)return json({error:problem},400);
   const discount=discountFor(c,subtotal);
   return json({ok:true,code:c.code,discount_cents:discount,total_cents:subtotal-discount,description:c.discount_type==="percent"?Number(c.discount_value)+"% de desconto":"Desconto de R$ "+(Number(c.discount_value)/100).toFixed(2).replace(".",",")});
  }
  if(!env.ADMIN_PASSWORD)return json({error:"Painel administrativo indisponível."},503);
  if(!await authorized(request,env.ADMIN_PASSWORD))return json({error:"Acesso não autorizado."},401);
  if(request.method==="GET") {const {results=[]}=await env.DB.prepare("SELECT * FROM coupons ORDER BY created_at DESC,id DESC").all();return json({coupons:results});}
  if(request.method==="POST"){
   let b;try{b=await request.json();}catch{return json({error:"Dados inválidos."},400);}
   const code=clean(b.code,40).toUpperCase().replace(/\\s+/g,""),type=b.discount_type,value=Number(b.discount_value),minimum=Number(b.min_subtotal_cents||0),max=b.max_uses===""||b.max_uses===null||b.max_uses===undefined?null:Number(b.max_uses),starts=clean(b.starts_at,30)||null,expires=clean(b.expires_at,30)||null;
   if(!/^[A-Z0-9_-]{3,40}$/.test(code))return json({error:"Use um código de 3 a 40 caracteres (letras, números, hífen ou underline)."},400);
   if(!["percent","fixed"].includes(type)||!Number.isSafeInteger(value)||value<1||(type==="percent"&&value>90))return json({error:"Desconto inválido. Percentual de 1% a 90% ou valor fixo em centavos."},400);
   if(!Number.isSafeInteger(minimum)||minimum<0||!(max===null||(Number.isSafeInteger(max)&&max>0)))return json({error:"Pedido mínimo ou limite de usos inválido."},400);
   if(starts&&expires&&Date.parse(starts)>=Date.parse(expires))return json({error:"A validade final deve ser posterior ao início."},400);
   try{const r=await env.DB.prepare("INSERT INTO coupons (code,discount_type,discount_value,min_subtotal_cents,max_uses,starts_at,expires_at,active) VALUES (?,?,?,?,?,?,?,1)").bind(code,type,value,minimum,max,starts,expires).run();return json({ok:true,id:r.meta.last_row_id},201);}catch(e){if(String(e.message).includes("UNIQUE"))return json({error:"Já existe um cupom com esse código."},409);throw e;}
  }
  if(request.method==="PATCH"){
   let b;try{b=await request.json();}catch{return json({error:"Dados inválidos."},400);}
   const id=Number(b.id);if(!Number.isSafeInteger(id)||id<1)return json({error:"Cupom inválido."},400);
   const r=await env.DB.prepare("UPDATE coupons SET active=? WHERE id=?").bind(b.active?1:0,id).run();
   return r.meta.changes?json({ok:true}):json({error:"Cupom não encontrado."},404);
  }
  if(request.method==="DELETE"){
   const id=Number(url.searchParams.get("id"));if(!Number.isSafeInteger(id)||id<1)return json({error:"Cupom inválido."},400);
   const used=await env.DB.prepare("SELECT id FROM order_coupon_redemptions WHERE coupon_id=? LIMIT 1").bind(id).first();
   if(used)return json({error:"Este cupom já foi usado em pedidos e não pode ser apagado. Desative-o para preservar o histórico."},409);
   const r=await env.DB.prepare("DELETE FROM coupons WHERE id=?").bind(id).run();return r.meta.changes?json({ok:true}):json({error:"Cupom não encontrado."},404);
  }
  return json({error:"Método não permitido."},405);
 }catch(e){return json({error:"Falha ao processar cupom: "+(e?.message||"erro interno")},500);}
}