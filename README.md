# YouTube Music no painel do GNOME

Extensão do GNOME Shell 50 que coloca o YouTube Music no painel superior. Pelo popup você vê suas playlists, abre e toca playlists ou músicas, busca músicas, adiciona músicas às suas playlists e controla a reprodução num mini player. As teclas de mídia do teclado e o controle de mídia do GNOME também funcionam.

## Como funciona

São duas partes:

- **Extensão** (`extension/`, UUID `ytmusic-panel@jayan`): só desenha a interface. Ela não acessa a rede; conversa com o serviço pelo D-Bus de sessão, sempre de forma assíncrona.
- **Serviço** (`daemon/`, `ytmusic-daemon`): processo Python que roda como serviço systemd de usuário. Usa o [ytmusicapi](https://github.com/sigma67/ytmusicapi) para falar com a sua conta, o `mpv` (só áudio) para tocar, o `yt-dlp` para obter o áudio e o plugin `mpv-mpris` para expor o player via MPRIS.

O serviço publica `io.github.jayan.YTMusic` no barramento de sessão (caminho `/io/github/jayan/YTMusic`). Todos os métodos devolvem JSON em texto: `{"ok": true, "data": ...}` ou `{"ok": false, "error": "...", "message": "..."}`.

## Requisitos

- Ubuntu 26.04 (ou outra distribuição com GNOME Shell 50, sessão Wayland ou X11)
- Pacotes do sistema: `mpv`, `mpv-mpris`, `python3-gi`, `python3-venv`

```bash
sudo apt install mpv mpv-mpris python3-gi python3-venv
```

O resto (ytmusicapi, yt-dlp e o runtime JavaScript `deno`, que o yt-dlp precisa para o YouTube) é instalado num ambiente virtual próprio em `~/.local/share/ytmusic-daemon/venv`. Nada é instalado com pip no Python do sistema.

## Instalação

```bash
git clone <url-do-repositório> ~/Projetos/ytmusic-panel
cd ~/Projetos/ytmusic-panel
./install.sh
```

O script:

1. confere os pacotes do sistema (se faltar algum, mostra o comando `apt` e para; ele nunca usa `sudo`);
2. cria o ambiente virtual, instala o serviço e o registra no systemd de usuário (`~/.config/systemd/user/ytmusic-daemon.service`), já iniciado e configurado para subir com a sessão;
3. instala a extensão em `~/.local/share/gnome-shell/extensions/` e a habilita, sem mexer nas suas outras extensões.

Depois faça o login (próxima seção) e **saia e entre de novo na sessão**. No Wayland a shell só reconhece extensões novas no login.

Para desenvolver, use `./install.sh --dev`: a extensão vira um link simbólico para a pasta `extension/` e o serviço é instalado em modo editável.

## Login

O serviço usa a sessão do YouTube que já está aberta no seu navegador (os cookies dele). Não precisa copiar nada:

1. No navegador, abra https://music.youtube.com e confira se está conectado na sua conta.
2. Abra as configurações da extensão (engrenagem ao lado da busca, ou `gnome-extensions prefs ytmusic-panel@jayan`).
3. Em **Conta e serviço**, escolha o navegador e clique em **Entrar com o navegador**.

Funciona com Firefox (inclusive o snap) e com os navegadores baseados no Chromium (Chrome, Chromium, Brave, Edge, Vivaldi, Opera); só o Firefox foi testado. As credenciais ficam em `~/.config/ytmusic-daemon/browser.json`, com permissão 600, e nunca aparecem nos logs. O serviço confere a sessão antes de trocar as credenciais em uso.

**A sessão é a mesma do navegador.** Se você sair da conta do YouTube naquele navegador, o app também é desconectado; para voltar, entre de novo no navegador e clique em **Entrar com o navegador**. Enquanto você estiver conectado lá, o serviço renova o acesso sozinho quando o YouTube recusar as credenciais. **Sair da conta neste app** apaga as credenciais só daqui.

### Login manual (alternativa)

Copiando os cabeçalhos de uma requisição do navegador. Rode **num terminal seu**:

```bash
~/.local/share/ytmusic-daemon/venv/bin/ytmusic-daemon-login
```

E siga os passos:

1. Abra https://music.youtube.com logado na sua conta.
2. Abra as ferramentas de desenvolvedor (F12), aba **Rede** (Network), e filtre por `browse`.
3. Clique em **Biblioteca** na página para gerar uma requisição.
4. Escolha uma requisição **POST** para `browse?...` com status 200. Ela precisa ter os cabeçalhos `Cookie` e `X-Goog-AuthUser`.
5. Copie os cabeçalhos da requisição:
   - Firefox: botão direito na requisição, **Copiar valor**, **Copiar cabeçalhos da requisição**.
   - Chrome: aba **Headers**, selecione todo o bloco **Request Headers** e copie.
6. Cole no terminal, aperte Enter e depois **Ctrl+D**.

## Uso

Clique no ícone no painel.

- **Busca**: o campo no topo já recebe o foco; os resultados aparecem quando você para de digitar (ou com Enter). Dentro de uma playlist, o campo fica abaixo do nome dela e filtra só as músicas da playlist (título, artista ou álbum, sem diferenciar acentos).
- **Playlists**: "Músicas que gostei" fica sempre no topo. Clique numa playlist para ver as músicas.
- **Ordem da playlist**: ela abre com as músicas adicionadas mais recentemente no topo. O botão ao lado de atualizar inverte para as mais antigas primeiro (fica destacado enquanto ativo); ao abrir a playlist de novo, volta para as mais recentes. Tocar a partir de uma música segue a ordem que está na tela.
- **Tocar**: o ▶ de uma música toca a partir dela e segue a playlist. Num resultado de busca, toca só aquela música.
- **Menu de uma música** (⋮, dentro de uma playlist; abre um menu flutuante, que fecha ao clicar fora): adicionar à fila, tocar a seguir, adicionar a outra playlist, compartilhar (copia o link `music.youtube.com` e mostra "Link copiado") e remover da playlist (só nas suas playlists; pede um segundo clique para confirmar). Remover de "Músicas que gostei" equivale a descurtir.
- **Adicionar a uma playlist**: nos resultados da busca, o botão **+** abre a lista das suas playlists. Adicionar a "Músicas que gostei" equivale a curtir a música.
- **Mini player** (rodapé): repetir, aleatório, anterior, play/pause e próxima. "Anterior" com mais de 3 segundos de música volta ao começo dela. Repetir alterna entre desligado, repetir a fila e repetir a música atual (ícone com "1"); aleatório embaralha o resto da fila, e desligar volta à ordem original. Quando ligados, os dois ficam na cor de destaque do sistema. Títulos longos rolam devagar para mostrar o nome inteiro.
- **Teclas de mídia** e o controle de mídia do GNOME (menu de data e hora) controlam o mesmo player, que aparece como `org.mpris.MediaPlayer2.mpv.ytmusic`.

### Preferências

```bash
gnome-extensions prefs ytmusic-panel@jayan
```

A janela mostra a sua conta (foto, nome e @) no topo e, abaixo, as seções:

- **Aparência**: tema do popup (automático, claro ou escuro), altura do popup (fixa; se não couber na tela, diminui sozinha) e mostrar capas
- **Biblioteca**: mostrar "Episódios para mais tarde" (lista de podcasts salvos; escondida por padrão)
- **Conta e serviço**: comandos de login e de logs

A engrenagem ao lado da busca, no popup, abre a mesma janela.

## Logs e diagnóstico

```bash
journalctl --user -fu ytmusic-daemon                      # serviço
journalctl -f -o cat /usr/bin/gnome-shell | grep -i ytmusic # extensão
systemctl --user status ytmusic-daemon
busctl --user call io.github.jayan.YTMusic /io/github/jayan/YTMusic io.github.jayan.YTMusic GetStatus
```

### Problemas comuns

- **"Você não está conectado"**: confira se está conectado no navegador e clique em **Entrar com o navegador** nas configurações.
- **"O serviço ytmusic-daemon não está respondendo"**: `systemctl --user restart ytmusic-daemon` e veja o journal.
- **A música não toca, ou o journal mostra "track failed to play"**: o YouTube muda as proteções com frequência. Atualize o yt-dlp com `./scripts/install-daemon.sh` (ele sempre instala a versão mais nova) e reinicie o serviço.
- **Demora para começar a tocar**: obter o áudio de uma música leva cerca de 2 a 4 segundos. Para esconder isso, o serviço começa a buscar o áudio quando você para o mouse sobre uma música, e busca a próxima da fila enquanto a atual toca; nesses casos ela começa em menos de 1 segundo.

## Desinstalação

```bash
./uninstall.sh          # mantém as credenciais
./uninstall.sh --purge  # apaga também credenciais e cache de capas
```

## Desenvolvimento

Estrutura:

```
extension/              extensão GNOME Shell (GJS, módulos ES)
  extension.js          botão do painel e popup
  ytmusicClient.js      cliente D-Bus assíncrono
  prefs.js              preferências (Adw)
daemon/ytmusic_daemon/  serviço Python
  service.py            interface D-Bus
  client.py             ytmusicapi, caches
  player.py             mpv via IPC
  covers.py             cache de capas em disco
  login.py              ytmusic-daemon-login (login manual)
  browser_login.py      login com os cookies do navegador
  resolver.py           obtém o áudio com antecedência (yt-dlp como biblioteca)
  preload.lua           script do mpv que usa o áudio já obtido
scripts/
  install-daemon.sh     venv, pacote e serviço systemd
  dev-link.sh           liga a extensão a ~/.local/share e compila o schema
  nested-shell.sh       shell aninhada para testes, com o serviço no barramento dela
  check-interface.py    confere se a interface D-Bus da extensão bate com a do serviço
```

Ciclo de desenvolvimento:

- **Extensão**: `./scripts/nested-shell.sh` abre uma GNOME Shell numa janela, com uma cópia do serviço no barramento isolado dela. Feche e abra de novo para recarregar o código. Os logs saem no terminal.
- **Serviço**: depois de editar, `systemctl --user restart ytmusic-daemon`.
- **Interface D-Bus**: ao adicionar ou mudar um método, atualize `INTROSPECTION_XML` em `service.py` e `IFACE_XML` em `ytmusicClient.js`, e rode `python3 scripts/check-interface.py`.
- Para testar a reprodução sem som, inicie o serviço com `YTMUSIC_MPV_EXTRA_ARGS=--ao=null`.

### Decisões e armadilhas conhecidas

- O yt-dlp usa o cliente `web_music` do YouTube: as URLs do cliente padrão retornam 403 quando abertas pelo mpv.
- `--audio-client-name` do mpv não pode ter espaço: o mpv-mpris usa esse valor no nome D-Bus, e um nome inválido trava o mpv.
- A busca usa o ytmusicapi em inglês, porque com idioma `pt` o filtro de músicas volta vazio. Títulos e artistas não são traduzidos, então nada muda na tela.
