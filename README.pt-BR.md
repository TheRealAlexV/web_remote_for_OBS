# Web remote for OBS
Interface web para controlar o [OBS Studio](https://obsproject.com/) pelo servidor obs-websocket que já vem embutido no OBS.

[English](README.md)

**[→ Demo online](https://dvangennip.github.io/web_remote_for_OBS/)** — dá para ver a interface por lá, mas uma página em `https` não consegue abrir uma conexão `ws://` com o OBS da sua máquina. Para controlar o OBS de verdade, sirva a pasta localmente como explicado abaixo.

## Captura de tela
![prévia da interface com a barra de status no topo, as cenas no meio e os controles de áudio abaixo.](documents/web-remote-screenshot-v3.png "Interface principal do Web remote for OBS.")

## Requisitos
- OBS Studio 28 ou mais novo. O OBS 28 foi a primeira versão a trazer o obs-websocket 5, então o servidor WebSocket já vem embutido; não há plugin para instalar.
- Testado com OBS Studio 33.0.1 e obs-websocket 5.7.6, rpcVersion 1.
- Servidor WebSocket ativado no OBS em **Ferramentas → Configurações do servidor WebSocket**. Ele já vem ativado na porta `4455`; defina uma senha ali.
- Um navegador com suporte a módulos ES (qualquer navegador atual).

## Como usar
1. Baixe ou clone este repositório.
2. Sirva a raiz do repositório (onde fica o `index.html`) por HTTP.
    - Por exemplo: `python3 -m http.server 8000`
    - Depois abra [`http://localhost:8000`](http://localhost:8000)
3. Na caixa de conexão, informe o host e a senha que você definiu no OBS e conecte.
    - O host vem preenchido com `localhost:4455`.
    - Aceita só o host (`192.168.1.20`), host e porta (`192.168.1.20:4455`) ou uma URL completa `ws://` ou `wss://`.
4. Controle o OBS pela página.

> **Sirva por HTTP, não abra o arquivo direto.** Módulos ES e `ws://` precisam de uma origem real, então abrir o `index.html` direto do disco (`file://`) não funciona. Uma cópia hospedada em `https`, como no GitHub Pages, também não consegue abrir `ws://` para o OBS local: o navegador bloqueia esse conteúdo misto. Se você precisar hospedar a página em `https`, o WebSocket também tem que estar atrás de TLS (`wss://`).

## Recursos
- Ativar/desativar o Modo Estúdio (atalho: `S`)
- Alternar entre cenas
    - Atalho de transição: `T` (só no Modo Estúdio)
    - Clique com o botão esquerdo para trocar de cena ou, no Modo Estúdio, definir a cena de pré-visualização
    - Use `0-9` para escolher a cena numerada (só vale para as dez primeiras cenas)
- Controlar fontes de áudio
    - Mudo/desmudo
    - Mostrar/ocultar
    - Volume
    - Medidores de volume ao vivo por fonte, alimentados pelo evento `InputVolumeMeters` do obs-websocket 5
    - Configurações de filtro (não são todos os filtros que funcionam)
- Alterar propriedades de itens de cena
    - Posição
    - Escala
    - Rotação
    - Alinhamento
    - Caixa delimitadora
    - Corte
- Ativar/desativar fontes
- Alterar propriedades de fontes
    - Texto
    - Mídia
- Alterar propriedades de filtros de fonte
    - Correção de cor
    - Chroma key e chave de cor (v1 e v2): cor e tipo da chave, similaridade, suavidade, transbordamento (spill), opacidade, contraste, brilho, gama
- Tirar captura da cena atual do programa
- Iniciar/parar gravação, transmissão e buffer de replay
- Iniciar/parar a câmera virtual
- Ver estatísticas
- Atalhos
    - Atualizar (`R`)
    - Salvar buffer de replay (`P`)
- Adicionar fontes às cenas

## Observações e problemas conhecidos
- Uma cópia servida por `https` não conecta em um servidor `ws://` simples na sua máquina; use um servidor `http://` local (veja [Como usar](#como-usar)).
- A interface ainda não é otimizada para celular.
- Cenas com `hidden` ou `subscene` no nome são ignoradas e não aparecem na lista.
- Os medidores de volume só se atualizam para fontes que estão produzindo áudio de fato; é o que o obs-websocket informa.
- Para mais detalhes, veja as [issues](https://github.com/dvangennip/web_remote_for_OBS/issues)

## Edição de fontes de texto
O app não lista suas fontes. Você escolhe as que quer editar adicionando um `<input>` com o atributo `data-wr-source` à lista `#source_list` no `index.html`. O `name` do input precisa ser o nome da fonte no OBS. Depois que o app conecta, cada input escolhido é trocado por um painel recolhível preenchido a partir do OBS, então você edita o texto que a fonte já tem em vez de sobrescrevê-lo.

Um bloco completo para duas fontes, com um seletor que escreve um valor nas duas:

```html
<ul id="source_list" class="source-list">
	<li>
		<input type="text" id="name_a" name="Name A" data-wr-source="Name A">
	</li>
	<li>
		<input type="text" id="name_b" name="Name B" data-wr-source="Name B">
	</li>
</ul>
<select data-wr-selector="name_a|name_b">
	<option value="Both|Both">Ambas</option>
	<option value="First|Second">Primeira e segunda</option>
</select>
```

O painel abre com um clique e lê a fonte quando abre. Cada controle escreve a própria configuração no OBS ao mudar:

- Texto: caixa de várias linhas. Grava 300 ms depois que você para de digitar, e na hora quando a caixa perde o foco ou o painel recolhe.
- Fonte e tamanho: o objeto `font`. O OBS resolve o nome da fonte e usa outra quando o nome não existe.
- Cor e opacidade: `color` e `opacity`. A cor é um seletor; a opacidade vai de 0 a 100.
- Contorno: `outline`, com `outline_size` e `outline_color`. Tamanho e cor ficam desativados enquanto o contorno está desligado.
- Alinhamento: `align` e `valign`.

Toda fonte de texto no OBS ganha um painel automaticamente, sem marcação. Fontes de texto GDI+ (qualquer tipo `text_gdiplus*`) também recebem os controles de estilo; qualquer outra entrada, inclusive fontes de texto FreeType, recebe só a caixa de texto. O atributo `data-wr-source` só é necessário para forçar um painel em alguma outra entrada. Quando o OBS não conhece o nome, o painel mostra um estado de não encontrado e não grava nada.

### Escrever um valor em várias fontes
O atributo `data-wr-selector` lista os `id` dos inputs acima, separados por `|`. O valor de cada opção é o texto para essas fontes, na mesma ordem, também separado por `|`. Ao mudar, o app atualiza o input correspondente e envia o texto ao OBS. Os ids do atributo são os ids dos inputs, não os nomes das fontes.

O exemplo acima escreve `Both` em `Name A` e `Name B`, ou `First` em `Name A` e `Second` em `Name B`.

## Licença
- [Unlicense](https://unlicense.org/): software livre e sem restrições, liberado para o domínio público.
- O [obs-websocket-js](https://github.com/obs-websocket-community-projects/obs-websocket-js) 5.0.8 está vendorizado em `vendor/obs-ws.global.js` e é carregado como script comum, então o app não precisa de build nem de instalação para rodar. O `vendor/README.md` registra a origem do bundle e o SHA-256; a licença MIT está em `vendor/obs-websocket-js.LICENSE`.
- Ícones: [Feather](https://feathericons.com/)
