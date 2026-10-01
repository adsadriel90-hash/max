# Ativação MaxPlayer

Formulário onde o cliente digita o login e a senha da assinatura. O sistema:

1. Busca no painel MaxPlayer o endereço salvo no domínio `MAXPLAYER_DOMAIN_ID` e confere
   nesse servidor Xtream se o login existe, está ativo, não venceu e não é teste (trial).
2. Consulta o cliente na API Sigma e só continua se o revendedor dono dele estiver em
   `SIGMA_REVENDAS_PERMITIDAS` (ID da Sigma ou usuário do revendedor). Também recusa trial.
3. Verifica se esse login já foi ativado no MaxPlayer.
4. Cria o cliente no MaxPlayer com o mesmo login e senha (`POST /users`), no domínio
   `MAXPLAYER_DOMAIN_ID` — a URL do servidor é a que está salva nesse domínio no painel.

## Estrutura
- `index.html` – formulário
- `api/ativar.js` – backend (função serverless da Vercel). A chave da API fica só aqui.

## Como publicar na Vercel
1. Suba esta pasta para um repositório no GitHub (ou rode `vercel` na pasta).
2. Em Project Settings > Environment Variables, cadastre as variáveis do `.env.example`.
3. Faça o deploy. O formulário fica em `https://seu-projeto.vercel.app`.

## Testar localmente
```
npm i -g vercel
cp .env.example .env   # preencha os valores
vercel dev
```

## Segurança
- Nunca coloque o `MAXPLAYER_TOKEN` no HTML.
- A lista de revendedores impede que clientes de outras revendas usem a sua conta MaxPlayer.
  Se a Sigma estiver fora do ar ou o cliente não for encontrado, a ativação é recusada.
- Clientes recusados por revenda aparecem no log da Vercel com o ID e o usuário do revendedor,
  o que ajuda a descobrir os IDs para a lista.
- A conferência no servidor do domínio impede que qualquer pessoa crie contas com login inventado.
- Use uma chave de provedor (ou de revenda com permissão `own_domains`): chaves de revenda comuns
  recebem o endereço do domínio oculto, e aí a ativação não consegue conferir o login.
- O limite de 5 tentativas por IP a cada 10 min é por instância. Se houver abuso,
  ative uma regra de rate limit no Firewall da Vercel.
