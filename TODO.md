# Pendências

## Etapa 9 (acabamento)
- Preferências: opção para mostrar ou esconder "Episódios para mais tarde" (playlist SE) no popup. Hoje ela fica sempre escondida.
- Reprodução mais rápida (opcional, proposta na Etapa 6): resolver a URL do áudio no próprio daemon com yt-dlp como biblioteca, entregando ao mpv por hook on_load no IPC, e resolver a próxima música com antecedência. Hoje são cerca de 3,5 s para começar e entre faixas.
