const headers={"content-type":"application/json; charset=utf-8","cache-control":"no-store"};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers});
const enc=new TextEncoder();
const b64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
async function sign(secret,value){const key=await crypto.subtle.importKey("raw",enc.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);return b64(await crypto.subtle.sign("HMAC",key,enc.encode(value)));}
async function authorized(request,secret){const raw=request.headers.get("authorization")||"";const parts=raw.replace(/^Bearer\s+/i,"").split(".");if(parts.length!==2)return false;const expected=await sign(secret,parts[0]);if(expected!==parts[1])return false;try{return JSON.parse(atob(parts[0].replace(/-/g,"+").replace(/_/g,"/"))).exp>Date.now();}catch{return false;}}
const allowed=["pending","confirmed","processing","shipped","delivered","cancelled"];
const parseJson=v=>{try{return v?JSON.parse(v):{};}catch{return {};}};
const clean=(v,max=160)=>String(v??"").trim().slice(0,max);
async function createOrder(request,db){
 let b;try{b=await request.json();}catch{return json({error:"Não foi possível ler os dados da compra."},400);}
 const name=clean(b.name,120),email=clean(b.email,180).toLowerCase(),phone=clean(b.phone,40);
 const address=b.address||{},street=clean(address.street,140),number=clean(address.number,20),neighborhood=clean(address.neighborhood,100),city=clean(address.city,100),state=clean(address.state,2).toUpperCase(),postal=clean(address.postal_code,12);
 if(name.length<2||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||phone.length<8)return json({error:"Informe nome, e-mail e telefone válidos."},400);
 if(!street||!number||!neighborhood||!city||state.length!==2||postal.length<8)return json({error:"Complete o endereço de entrega para registrar o pedido."},400);
 if(!Array.isArray(b.items)||b.items.length<1||b.items.length>30)return json({error:"Sua sacola está vazia ou contém itens demais."},400);
 const grouped=new Map();
 for(const item of b.items){const id=Number(item.id),qty=Number(item.quantity),size=clean(item.size,30);if(!Number.isSafeInteger(id)||id<1||!Number.isSafeInteger(qty)||qty<1||qty>20)return json({error:"Confira os produtos e quantidades da sacola."},400);const old=grouped.get(id);if(old){old.quantity+=qty;if(old.quantity>20)return json({error:"Limite de 20 unidades por produto."},400);}else grouped.set(id,{id,quantity:qty,size});}
 const items=[...grouped.values()];
 const ids=items.map(x=>x.id),marks=ids.map(()=>"?").join(",");
 const {results:productRows=[]}=await db.prepare("SELECT p.id,p.name,p.sku,p.price_cents,p.stock_quantity,p.active,p.sizes_json FROM products p WHERE p.id IN ("+marks+")").bind(...ids).all();
 if(productRows.length!==items.length)return json({error:"Um dos produtos não está mais disponível. Atualize sua sacola."},409);
 let subtotal=0;
 for(const item of items){const p=productRows.find(x=>x.id===item.id);if(!p.active)return json({error:p.name+" não está disponível no momento."},409);if(p.stock_quantity<item.quantity)return json({error:"Estoque insuficiente para "+p.name+". Disponível: "+p.stock_quantity+"."},409);const sizes=parseJson(p.sizes_json);if(Array.isArray(sizes)&&sizes.length&&!sizes.includes(item.size))return json({error:"Escolha um tamanho válido para "+p.name+"."},400);item.product=p;subtotal+=p.price_cents*item.quantity;}
 if(!Number.isSafeInteger(subtotal)||subtotal<0)return json({error:"Não foi possível calcular o total."},400);
 let coupon=null,discount=0,couponCode=clean(b.coupon_code,40).toUpperCase();
 if(couponCode){
  await db.prepare("CREATE TABLE IF NOT EXISTS coupons (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE COLLATE NOCASE, discount_type TEXT NOT NULL CHECK(discount_type IN ('percent','fixed')), discount_value INTEGER NOT NULL, min_subtotal_cents INTEGER NOT NULL DEFAULT 0, max_uses INTEGER, used_count INTEGER NOT NULL DEFAULT 0, starts_at TEXT, expires_at TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS order_coupon_redemptions (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, coupon_id INTEGER NOT NULL, code TEXT NOT NULL, discount_cents INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
  coupon=await db.prepare("SELECT * FROM coupons WHERE code=? COLLATE NOCASE").bind(couponCode).first();
  if(!coupon)return json({error:"Cupom não encontrado."},400);
  const now=Date.now(),start=coupon.starts_at?Date.parse(String(coupon.starts_at).replace(" ","T")+"Z"):0,end=coupon.expires_at?Date.parse(String(coupon.expires_at).replace(" ","T")+"Z"):Infinity;
  if(!coupon.active)return json({error:"Este cupom não está ativo."},400);
  if(start&&start>now)return json({error:"Este cupom ainda não começou."},400);
  if(end<now)return json({error:"Este cupom expirou."},400);
  if(coupon.max_uses!==null&&Number(coupon.used_count)>=Number(coupon.max_uses))return json({error:"Este cupom atingiu o limite de utilizações."},400);
  if(subtotal<Number(coupon.min_subtotal_cents||0))return json({error:"O pedido mínimo para este cupom é R$ "+(Number(coupon.min_subtotal_cents)/100).toFixed(2).replace(".",",")+"."},400);
  discount=Math.min(subtotal,coupon.discount_type==="percent"?Math.floor(subtotal*Math.min(90,Number(coupon.discount_value))/100):Number(coupon.discount_value));
 }
 const total=subtotal-discount;
 const orderNumber="HM-"+new Date().toISOString().slice(0,10).replace(/-/g,"")+"-"+crypto.randomUUID().slice(0,6).toUpperCase();
 const addressJson=JSON.stringify({recipient:name,street,number,complement:clean(address.complement,100),neighborhood,city,state,postal_code:postal});
 const requestRows=items.map((x,i)=>(i?" UNION ALL ":"")+"SELECT ? AS id, ? AS qty").join("");
 const stockBindings=items.flatMap(x=>[x.id,x.quantity]);
 const couponGuard=coupon?" AND EXISTS (SELECT 1 FROM coupons WHERE id=? AND active=1 AND (max_uses IS NULL OR used_count<max_uses))":"";
 const orderSql="INSERT INTO orders (order_number,customer_id,status,payment_method,payment_status,subtotal_cents,shipping_cents,discount_cents,total_cents,shipping_address_json) SELECT ?, (SELECT id FROM customers WHERE email=?), 'pending','A combinar','pending',?,0,?,?,? WHERE NOT EXISTS (SELECT 1 FROM ("+requestRows+") requested LEFT JOIN products p ON p.id=requested.id WHERE p.id IS NULL OR p.active!=1 OR p.stock_quantity<requested.qty)"+couponGuard;
 const statements=[db.prepare("INSERT INTO customers (name,email,phone) VALUES (?,?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name,phone=excluded.phone").bind(name,email,phone),db.prepare(orderSql).bind(orderNumber,email,subtotal,discount,total,addressJson,...stockBindings,...(coupon?[coupon.id]:[]))];
 for(const item of items){statements.push(db.prepare("INSERT INTO order_items (order_id,product_id,product_name,sku,size,color,quantity,unit_price_cents) SELECT o.id,p.id,p.name,p.sku,?,NULL,?,p.price_cents FROM orders o JOIN products p ON p.id=? WHERE o.order_number=?").bind(item.size||null,item.quantity,item.id,orderNumber));}
 for(const item of items){statements.push(db.prepare("UPDATE products SET stock_quantity=stock_quantity-?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND EXISTS (SELECT 1 FROM orders WHERE order_number=?)").bind(item.quantity,item.id,orderNumber));}
 if(coupon){
  statements.push(db.prepare("UPDATE coupons SET used_count=used_count+1 WHERE id=? AND active=1 AND (max_uses IS NULL OR used_count<max_uses) AND EXISTS (SELECT 1 FROM orders WHERE order_number=?)").bind(coupon.id,orderNumber));
  statements.push(db.prepare("INSERT INTO order_coupon_redemptions (order_id,coupon_id,code,discount_cents) SELECT id,?,?,? FROM orders WHERE order_number=?").bind(coupon.id,coupon.code,discount,orderNumber));
 }
 const results=await db.batch(statements);
 if(!results[1]?.meta?.changes)return json({error:"O estoque mudou enquanto você finalizava. Atualize a sacola e tente novamente."},409);
 return json({ok:true,order_number:orderNumber,subtotal_cents:subtotal,discount_cents:discount,total_cents:total,coupon_code:coupon?.code||null,message:"Pedido registrado. A loja precisa confirmar as condições de pagamento e entrega."},201);
}
export async function onRequest({request,env}){
 try{
  if(!env.DB)return json({error:"Banco de dados não configurado."},503);
  if(request.method==="POST")return await createOrder(request,env.DB);
  if(!env.ADMIN_PASSWORD)return json({error:"Configure ADMIN_PASSWORD nos Secrets do Cloudflare Pages."},503);
  if(!await authorized(request,env.ADMIN_PASSWORD))return json({error:"Acesso não autorizado."},401);
  if(request.method==="GET"){
   const [ordersResult,itemsResult,statsResult]=await Promise.all([
    env.DB.prepare("SELECT o.id,o.order_number,o.customer_id,o.status,o.payment_method,o.payment_status,o.shipping_carrier,o.tracking_code,o.subtotal_cents,o.shipping_cents,o.discount_cents,o.total_cents,o.shipping_address_json,o.created_at,o.updated_at,c.name AS customer_name,c.email AS customer_email,c.phone AS customer_phone FROM orders o LEFT JOIN customers c ON c.id=o.customer_id ORDER BY o.created_at DESC,o.id DESC LIMIT 300").all(),
    env.DB.prepare("SELECT oi.order_id,oi.product_id,oi.product_name,oi.sku,oi.size,oi.color,oi.quantity,oi.unit_price_cents FROM order_items oi ORDER BY oi.order_id DESC,oi.id").all(),
    env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status IN ('pending','confirmed','processing') THEN 1 ELSE 0 END) AS open_count, SUM(CASE WHEN status='delivered' THEN 1 ELSE 0 END) AS delivered_count, SUM(CASE WHEN status!='cancelled' THEN total_cents ELSE 0 END) AS revenue_cents FROM orders").first()
   ]);
   const grouped={};for(const item of itemsResult.results||[]){(grouped[item.order_id]??=[]).push(item);}
   return json({orders:(ordersResult.results||[]).map(o=>({...o,shipping_address:parseJson(o.shipping_address_json),items:grouped[o.id]||[]})),stats:{total:Number(statsResult?.total||0),open:Number(statsResult?.open_count||0),delivered:Number(statsResult?.delivered_count||0),revenue_cents:Number(statsResult?.revenue_cents||0)}});
  }
  if(request.method==="PATCH"){
   let body;try{body=await request.json();}catch{return json({error:"Dados inválidos."},400);}
   const id=Number(body.id),status=String(body.status||"");
   if(!Number.isSafeInteger(id)||id<1||!allowed.includes(status))return json({error:"Pedido ou status inválido."},400);
   const current=await env.DB.prepare("SELECT status FROM orders WHERE id=?").bind(id).first();
   if(!current)return json({error:"Pedido não encontrado."},404);
   if(current.status==="cancelled"&&status!=="cancelled")return json({error:"Um pedido cancelado não pode ser reativado. Crie um novo pedido."},409);
   const carrier=clean(body.shipping_carrier,100),tracking=clean(body.tracking_code,100);
   if(status==="cancelled"&&current.status!=="cancelled"){
    await env.DB.batch([
     env.DB.prepare("UPDATE products SET stock_quantity=stock_quantity+(SELECT COALESCE(SUM(quantity),0) FROM order_items WHERE order_id=? AND product_id=products.id),updated_at=CURRENT_TIMESTAMP WHERE id IN (SELECT product_id FROM order_items WHERE order_id=? AND product_id IS NOT NULL) AND EXISTS (SELECT 1 FROM orders WHERE id=? AND status!='cancelled')").bind(id,id,id),
     env.DB.prepare("UPDATE orders SET status='cancelled',shipping_carrier=?,tracking_code=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status!='cancelled'").bind(carrier||null,tracking||null,id)
    ]);
   }else{
    await env.DB.prepare("UPDATE orders SET status=?,shipping_carrier=?,tracking_code=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(status,carrier||null,tracking||null,id).run();
   }
   return json({ok:true});
  }
  return json({error:"Método não permitido."},405);
 }catch(error){return json({error:"Falha na operação de pedidos: "+(error?.message||"erro interno")},500);}
}