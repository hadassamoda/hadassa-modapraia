const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const json = (data, status=200) => new Response(JSON.stringify(data), { status, headers });
const enc = new TextEncoder();
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
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
  try {
    const normalized=parts[0].replace(/-/g,"+").replace(/_/g,"/");
    const payload=JSON.parse(atob(normalized));
    return payload.exp > Date.now();
  } catch { return false; }
}
const defaultCategories = ["Moda praia","Biquínis","Maiôs","Saídas de praia","Conjuntos","Shorts e calças","Acessórios","Outros"];
const slugify = value => String(value||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"") || "produto";
async function ensureCategories(db) {
  for(let i=0;i<defaultCategories.length;i++) {
    const name=defaultCategories[i];
    await db.prepare("INSERT OR IGNORE INTO categories (name,slug,sort_order,active) VALUES (?,?,?,1)")
      .bind(name,slugify(name),i).run();
  }
}
async function categoryId(db, name) {
  const clean=String(name||"Moda praia").trim() || "Moda praia";
  await db.prepare("INSERT OR IGNORE INTO categories (name,slug,sort_order,active) VALUES (?,?,99,1)")
    .bind(clean,slugify(clean)).run();
  const row=await db.prepare("SELECT id FROM categories WHERE name=?").bind(clean).first();
  return row.id;
}
function sizesValue(raw) {
  if(!raw) return "";
  try { const parsed=JSON.parse(raw); return Array.isArray(parsed)?parsed.join(", "):String(raw); }
  catch { return String(raw); }
}
async function getProducts(db, includeInactive=false) {
  const sql = `SELECT p.id,p.name,p.description,ROUND(p.price_cents/100.0,2) AS price,
    p.stock_quantity AS stock,p.active,COALESCE(c.name,'Moda praia') AS category,
    COALESCE((SELECT image_url FROM product_images WHERE product_id=p.id ORDER BY sort_order,id LIMIT 1),'') AS image,
    COALESCE(p.sizes_json,'') AS sizes_json
    FROM products p LEFT JOIN categories c ON c.id=p.category_id
    ${includeInactive?'':'WHERE p.active=1'} ORDER BY p.id DESC`;
  const {results=[]}=await db.prepare(sql).all();
  return results.map(p=>({...p,active:Boolean(p.active),sizes:sizesValue(p.sizes_json)}));
}
function imageError(image) {
  if(!image) return null;
  if(typeof image!=="string" || image.length>700000) return "A foto ficou muito grande ou é inválida. Escolha uma imagem menor.";
  if(image.startsWith("data:")) {
    if(!/^data:image\/(?:webp|jpeg|png|gif);base64,[a-z0-9+/]+=*$/i.test(image)) return "Formato de foto não permitido. Use JPG, PNG ou WEBP.";
  } else {
    try { const u=new URL(image); if(!["http:","https:"].includes(u.protocol)) return "O endereço da foto precisa começar com http:// ou https://"; }
    catch { return "O endereço da foto não é válido."; }
  }
  return null;
}
async function saveImage(db, productId, image) {
  const invalid=imageError(image);
  if(invalid) throw new Error(invalid);
  await db.prepare("DELETE FROM product_images WHERE product_id=?").bind(productId).run();
  if(image) {
    await db.prepare("INSERT INTO product_images (product_id,image_url,alt_text,sort_order) VALUES (?,?,?,0)")
      .bind(productId,image,"Foto do produto").run();
  }
}
export async function onRequest({request,env}) {
  try {
    if(!env.DB) return json({error:"Banco de dados não configurado."},503);
    if(!env.ADMIN_PASSWORD) return json({error:"Configure ADMIN_PASSWORD nos Secrets do Cloudflare Pages."},503);
    const url=new URL(request.url);
    if(request.method==="POST" && url.searchParams.get("action")==="login") {
      let body; try { body=await request.json(); } catch { return json({error:"Dados inválidos."},400); }
      if(typeof body.password!=="string" || body.password!==env.ADMIN_PASSWORD) return json({error:"Senha incorreta."},401);
      return json({token:await token(env.ADMIN_PASSWORD,Date.now()+12*60*60*1000)});
    }
    await ensureCategories(env.DB);
    if(request.method==="GET") {
      const adminView=url.searchParams.get("admin")==="1";
      if(adminView && !await authorized(request,env.ADMIN_PASSWORD)) return json({error:"Acesso não autorizado."},401);
      return json({products:await getProducts(env.DB,adminView)});
    }
    if(!await authorized(request,env.ADMIN_PASSWORD)) return json({error:"Acesso não autorizado."},401);
    if(request.method==="POST" || request.method==="PUT") {
      let p; try { p=await request.json(); } catch { return json({error:"Dados inválidos."},400); }
      if(!p.name?.trim() || !Number.isFinite(Number(p.price)) || Number(p.price)<0) return json({error:"Informe nome e preço válido."},400);
      const stock=Number(p.stock??0);
      if(!Number.isSafeInteger(stock) || stock<0) return json({error:"Informe uma quantidade de estoque válida."},400);
      const invalidImage=imageError(p.image||"");
      if(invalidImage) return json({error:invalidImage},400);
      const catId=await categoryId(env.DB,p.category);
      const sizes=String(p.sizes||"").split(",").map(v=>v.trim()).filter(Boolean);
      const sizesJson=sizes.length?JSON.stringify(sizes):null;
      const active=p.active===false || p.active==="0" ? 0 : 1;
      if(request.method==="POST") {
        const slug=slugify(p.name)+"-"+crypto.randomUUID().slice(0,8);
        const r=await env.DB.prepare("INSERT INTO products (category_id,name,slug,description,price_cents,stock_quantity,sizes_json,active,updated_at) VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)")
          .bind(catId,p.name.trim(),slug,p.description||"",Math.round(Number(p.price)*100),stock,sizesJson,active).run();
        const id=r.meta.last_row_id;
        await saveImage(env.DB,id,p.image||"");
        return json({ok:true,id},201);
      }
      const id=Number(url.searchParams.get("id"));
      if(!Number.isInteger(id)||id<1) return json({error:"ID inválido."},400);
      const r=await env.DB.prepare("UPDATE products SET category_id=?,name=?,description=?,price_cents=?,stock_quantity=?,sizes_json=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .bind(catId,p.name.trim(),p.description||"",Math.round(Number(p.price)*100),stock,sizesJson,active,id).run();
      if(!r.meta.changes) return json({error:"Produto não encontrado."},404);
      await saveImage(env.DB,id,p.image||"");
      return json({ok:true});
    }
    if(request.method==="DELETE") {
      const id=Number(url.searchParams.get("id"));
      if(!Number.isInteger(id)||id<1) return json({error:"ID inválido."},400);
      const linked=await env.DB.prepare("SELECT id FROM order_items WHERE product_id=? LIMIT 1").bind(id).first();
      if(linked) return json({error:"Este produto já aparece em um pedido e não pode ser apagado. Edite e marque como Inativo para preservar o histórico."},409);
      try {
        await env.DB.prepare("DELETE FROM product_images WHERE product_id=?").bind(id).run();
        const r=await env.DB.prepare("DELETE FROM products WHERE id=?").bind(id).run();
        return r.meta.changes?json({ok:true}):json({error:"Produto não encontrado."},404);
      } catch(error) {
        if(String(error?.message||"").includes("FOREIGN KEY constraint failed")) return json({error:"Este produto está vinculado a um pedido e não pode ser excluído. Edite o produto e marque como Inativo."},409);
        throw error;
      }
    }
    return json({error:"Método não permitido."},405);
  } catch(error) {
    return json({error:"Falha na operação do catálogo: "+(error?.message||"erro interno")},500);
  }
}
