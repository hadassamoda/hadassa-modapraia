# Hadassa Moda — Moda Praia

Loja virtual independente de varejo de moda praia. Frontend em Vite, pronto para Cloudflare Pages.

## Desenvolvimento

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Implantação no Cloudflare Pages

- Repositório: `hadassamoda/hadassa-modapraia`
- Branch de produção: `main`
- Comando de build: `npm run build`
- Diretório de saída: `dist`
- Diretório raiz: `/`
- Atualizações automáticas: habilitadas para commits na branch `main`.

## Estado das integrações

- Vitrine responsiva, categorias e sacola demonstrativa implementadas.
- Cloudflare Pages e banco Cloudflare D1 provisionados.
- Catálogo, estoque, clientes, pedidos, checkout, pagamento Pix/cartão, cálculo de frete, autenticação e painel administrativo ainda precisam de API e credenciais reais.
- Não usar para receber pagamentos reais até concluir as integrações e os testes.
