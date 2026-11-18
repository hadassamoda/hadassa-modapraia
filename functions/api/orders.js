const headers={"content-type":"application/json; charset=utf-8","cache-control":"no-store"};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers});
const enc=new TextEncoder();
const b64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
async function sign(secret,value){const key=await crypto.subtle.importKey("raw",enc.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);return b64(await crypto.subtle.sign("HMAC",key,enc.encode(value)));}
async function authorized(request,secret){const raw=request.headers.get("authorization")||"";const parts=raw.replace(/^Bearer\s+/i,"").split(".");if(parts.length!==2)return false;const expected=await sign(secret,parts[0]);if(expected!==parts[1])return false;try{const normalized=parts[0].replace(/-/g,"+").replace(/_/g,"/");return JSON.parse(atob(normalized)).exp>Date.now();}catch{return false;}}
const allowed=["pending","confirmed","processing","shipped","delivered","cancelled"];
function parseJson(v){try{return v?JSON.parse(v):{};}catch{return {};}}
export async function onRequest({request,env}){
 try{
  if(!env.DB)return json({error:"Banco de dados não configurado."},503);
  if(!env.ADMIN_PASSWORD)return json({error:"Configure ADMIN_PASSWORD nos Secrets do Cloudflare Pages."},503);
  if(!await authorized(request,env.ADMIN_PASSWORD))return json({error:"Acesso não autorizado."},401);
  if(request.method==="GET"){
   const [ordersResult,itemsResult,statsResult]=await Promise.all([
    env.DB.prepare("SELECT o.id,o.order_number,o.customer_id,o.status,o.payment_method,o.payment_status,o.shipping_carrier,o.tracking_code,o.subtotal_cents,o.shipping_cents,o.discount_cents,o.total_cents,o.shipping_address_json,o.created_at,o.updated_at,c.name AS customer_name,c.email AS customer_email,c.phone AS customer_phone FROM orders o LEFT JOIN customers c ON c.id=o.customer_id ORDER BY o.created_at DESC,o.id DESC LIMIT 300").all(),
    env.DB.prepare("SELECT oi.order_id,oi.product_id,oi.product_name,oi.sku,oi.size,oi.color,oi.quantity,oi.unit_price_cents FROM order_items oi ORDER BY oi.order_id DESC,oi.id").all(),
    env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status IN ('pending','confirmed','processing') THEN 1 ELSE 0 END) AS open_count, SUM(CASE WHEN status='delivered' THEN 1 ELSE 0 END) AS delivered_count, SUM(CASE WHEN status!='cancelled' THEN total_cents ELSE 0 END) AS revenue_cents FROM orders").first()
   ]);
   const grouped={};for(const item of itemsResult.results||[]){(grouped[item.order_id]??=[]).push(item);}
   const orders=(ordersResult.results||[]).map(o=>({...o,shipping_address:parseJson(o.shipping_address_json),items:grouped[o.id]||[]}));
   return json({orders,stats:{total:Number(statsResult?.total||0),open:Number(statsResult?.open_count||0),delivered:Number(statsResult?.delivered_count||0),revenue_cents:Number(statsResult?.revenue_cents||0)}});
  }
  if(request.method==="PATCH"){
   let body;try{body=await request.json();}catch{return json({error:"Dados inválidos."},400);}
   const id=Number(body.id),status=String(body.status||"");
   if(!Number.isSafeInteger(id)||id<1)return json({error:"Pedido inválido."},400);
   if(!allowed.includes(status))return json({error:"Status não permitido."},400);
   const carrier=String(body.shipping_carrier||"").trim().slice(0,100),tracking=String(body.tracking_code||"").trim().slice(0,100);
   const result=await env.DB.prepare("UPDATE orders SET status=?,shipping_carrier=?,tracking_code=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(status,carrier||null,tracking||null,id).run();
   if(!result.meta.changes)return json({error:"Pedido não encontrado."},404);
   return json({ok:true});
  }
  return json({error:"Método não permitido."},405);
 }catch(error){return json({error:"Falha ao consultar pedidos: "+(error?.message||"erro interno")},500);}
}