# Guia de Contribuição

Agradecemos o seu interesse em contribuir para o **Video Download Unlimited**. Este projeto é de código aberto e contribuições — seja reportando problemas, sugerindo melhorias ou submetendo código — são bem-vindas.

---

## Como Executar Localmente em Modo Desenvolvedor

Por ser uma extensão baseada puramente em padrões web nativos (**Manifest V3** e **WebAssembly**) sem etapas de build obrigatórias, o processo de execução é imediato:

1. Clone o repositório ou faça o download:
   ```bash
   git clone https://github.com/cblourenco/Video-Download-Unlimited.git
   cd "Video Download Unlimited"
   ```
2. Abra um navegador baseado em Chromium (Google Chrome, Brave, Microsoft Edge, Opera, etc.).
3. Acesse a página de extensões:
   ```text
   chrome://extensions/
   ```
4. Ative a opção **Modo do desenvolvedor** no canto superior direito.
5. Clique em **Carregar sem compactação** (*Load unpacked*) e selecione a pasta raiz deste repositório.
6. Sempre que fizer alterações no código:
   - Para arquivos em `popup/`, `options/` ou `sidepanel/`: basta fechar e reabrir a respectiva interface.
   - Para alterações em `background/service_worker.js` ou `manifest.json`: clique no botão de atualizar no card da extensão em `chrome://extensions/`.

---

## Diretrizes para Envio de Pull Requests

1. **Crie uma branch descritiva**:
   ```bash
   git checkout -b feature/sua-melhoria
   # ou
   git checkout -b fix/descricao-do-bug
   ```
2. **Boas Práticas de Código**:
   - Mantenha o padrão de código existente (Vanilla JS, modular, sem dependências externas desnecessárias).
   - Respeite a privacidade do usuário: nenhuma mídia ou dado de navegação deve ser enviado a servidores externos. Todo o processamento deve permanecer 100% in-browser.
   - Teste a extensão em pelo menos dois navegadores Chromium diferentes (ex.: Google Chrome e Microsoft Edge).
3. **Commit com clareza**:
   - Utilize mensagens de commit semânticas (`feat:`, `fix:`, `docs:`, `refactor:`, `perf:`).
4. **Abra um Pull Request**:
   - Forneça uma descrição detalhada da alteração e passos para testar.

---

## Reportando Problemas (Issues)

Ao abrir uma issue, certifique-se de incluir:
- Versão do navegador Chromium e Sistema Operacional.
- URL da página ou tipo de streaming (caso aplicável).
- Comportamento esperado vs. comportamento observado.
- Mensagens ou logs exibidos no DevTools da extensão (`chrome://extensions/` -> Inspecionar visualizações: `service worker` ou botão direito no popup -> `Inspecionar`).
