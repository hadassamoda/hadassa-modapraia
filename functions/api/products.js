const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const json = (data, status=200) => new Response(JSON.stringify(data), { status, headers });
const enc = new TextEncoder();
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
async function sign(secret, value) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
  return b64(await crypto.subtle.sign("HMAC", key, enc.encode(value)));
}
async function token(secret, exp) {
  const payload = b64(enc.encode(JSON.stringify({exp})));
  return payload + "." + await sign(secret, payload);
}
async function authorized(request, secret) {
  const raw = request.headers.get("authorization") || "";
  const parts = raw.replace(/^Bearer\s+/i,"").split(".");
  if(parts.length !== 2) return false;
  const expected = await sign(secret, parts[0]);
  if(expected !== parts[1]) return false;
  try { const payload = JSON.parse(atob(parts[0].replace(/-/g,"+").replace(/_/g,"/"))); return payload.exp > Date.now(); } catch { return false; }
}
async function ensure(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, description TEXT DEFAULT '', price REAL NOT NULL DEFAULT 0,
    image TEXT DEFAULT '', category TEXT DEFAULT 'Moda praia',
    sizes TEXT DEFAULT '', stock INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`).run();
}
export async function onRequest({request, env}) {
  if(!env.DB) return json({error:"Banco de dados não configurado."},503);
  if(!env.ADMIN_PASSWORD) return json({error:"Configure ADMIN_PASSWORD nos Secrets do Cloudflare Pages."},503);
  const url = new URL(request.url);
  if(request.method === "POST" && url.pathname.endsWith("/login")) {
    let body; try { body=await request.json(); } catch { return json({error:"Dados inválidos."},400); }
    if(typeof body.password !== "string" || body.password !== env.ADMIN_PASSWORD) return json({error:"Senha incorreta."},401);
    return json({token:await token(env.ADMIN_PASSWORD, Date.now()+12*60*60*1000)});
  }
  if(!await authorized(request, env.ADMIN_PASSWORD)) return json({error:"Acesso não autorizado."},401);
  await ensure(env.DB);
  if(request.method === "GET") {
    const {results=[]} = await env.DB.prepare("SELECT * FROM products ORDER BY id DESC").all();
    return json({products:results});
  }
  if(request.method === "POST") {
    let p; try { p=await request.json(); } catch { return json({error:"Dados inválidos."},400); }
    if(!p.name?.trim() || !Number.isFinite(Number(p.price))) return json({error:"Informe nome e preço válido."},400);
    const r=await env.DB.prepare("INSERT INTO products (name,description,price,image,category,sizes,stock,active,updated_at) VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)")
      .bind(p.name.trim(),p.description||"",Number(p.price),p.image||"",p.category||"Moda praia",p.sizes||"",Math.max(0,Number(p.stock)||0),p.active===false?0:1).run();
    return json({ok:true,id:r.meta.last_row_id},201);
  }
  const id=Number(url.searchParams.get("id"));
  if(!Number.isInteger(id) || id<1) return json({error:"ID inválido."},400);
  if(request.method === "PUT") {
    let p; try { p=await request.json(); } catch { return json({error:"Dados inválidos."},400); }
    if(!p.name?.trim() || !Number.isFinite(Number(p.price))) return json({error:"Informe nome e preço válido."},400);
    const r=await env.DB.prepare("UPDATE products SET name=?,description=?,price=?,image=?,category=?,sizes=?,stock=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(p.name.trim(),p.description||"",Number(p.price),p.image||"",p.category||"Moda praia",p.sizes||"",Math.max(0,Number(p.stock)||0),p.active===false?0:1,id).run();
    return r.meta.changes ? json({ok:true}) : json({error:"Produto não encontrado."},404);
  }
  if(request.method === "DELETE") {
    const r=await env.DB.prepare("DELETE FROM products WHERE id=?").bind(id).run();
    return r.meta.changes ? json({ok:true}) : json({error:"Produto não encontrado."},404);
  }
  return json({error:"Método não permitido."},405);
}