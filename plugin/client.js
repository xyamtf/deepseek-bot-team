window.__ModuleLoader__.load({
  id: 'dsh-bot-team',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const SERVICE = 'http://127.0.0.1:8790';
    const UI_URL = SERVICE + '/bot';
    const STATE_URL = SERVICE + '/api/state';
    const chatUrl = (botId) => SERVICE + '/api/chats/bot:' + botId + '/messages';
    const cancelUrl = (botId) => SERVICE + '/api/chats/bot:' + botId + '/cancel';

    /** The whale mark, shared by the sidebar row, the panel header and a Bot without a face. */
    function Whale(props) {
      const options = props || {};
      const size = options.size || 16;
      return h('svg', { viewBox: '0 0 256 256', width: size, height: size, 'aria-hidden': true, style: options.style },
        h('path', {
          d: 'M46 150c0-38 34-66 78-66 45 0 79 27 79 63 0 12-4 23-11 32 15 3 26 12 31 24-18 3-33-1-44-10-15 12-36 19-60 19-45 0-73-26-73-62z',
          fill: options.active ? 'currentColor' : '#4c72f5',
        }),
        h('circle', { cx: 104, cy: 136, r: 8, fill: '#fff' }),
        h('path', { d: 'M120 74c2-14 12-22 22-24-4 10-3 18 2 24-8 4-17 4-24 0z', fill: '#8fb2ff' }),
        h('circle', { cx: 106, cy: 62, r: 6, fill: '#8fb2ff' }),
        h('circle', { cx: 146, cy: 52, r: 5, fill: '#8fb2ff' }));
    }

    /** A Bot's look: a custom avatar wins, otherwise its skin image. */
    function botImage(bot) {
      if (!bot) return SERVICE + '/bot/skins/whale.svg';
      if (bot.avatar) return SERVICE + '/api/avatars/' + bot.avatar;
      const skin = bot.skin || 'whale';
      if (skin === 'whale') return SERVICE + '/bot/skins/whale.svg';
      return SERVICE + '/bot/skins/' + skin + '.png';
    }

    /** The looks a Bot can wear, and how they read in the picker. */
    const SKINS = [
      ['whale', '小鲸鱼'], ['fuzzy', '蓝色毛绒'], ['bubble', '泡泡'], ['glass', '粉色玻璃'],
      ['gold', '金色'], ['jade', '翡翠'], ['plush', '毛绒'], ['waffle', '华夫饼'],
      ['pixel', '像素'], ['smiley', '笑脸球'], ['toys', '玩具'], ['moon', '月岩'],
    ];

    /** Center-crops an image file to a 256px square PNG data URL (what the service accepts). */
    function resizeToDataUrl(file, size = 256) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('读取图片失败'));
        reader.onload = () => {
          const image = new Image();
          image.onerror = () => reject(new Error('这不是能识别的图片'));
          image.onload = () => {
            try {
              const side = Math.min(image.width, image.height);
              const sx = Math.floor((image.width - side) / 2);
              const sy = Math.floor((image.height - side) / 2);
              const canvas = document.createElement('canvas');
              canvas.width = size;
              canvas.height = size;
              const context = canvas.getContext('2d');
              context.drawImage(image, sx, sy, side, side, 0, 0, size, size);
              resolve(canvas.toDataURL('image/png'));
            } catch (error) {
              reject(new Error(String(error && error.message ? error.message : error)));
            }
          };
          image.src = String(reader.result);
        };
        reader.readAsDataURL(file);
      });
    }

    /** Uploads a scaled avatar and binds it to the Bot; resolves with the updated Bot. */
    async function uploadAvatar(botId, dataUrl) {
      const uploaded = await fetch(SERVICE + '/api/avatars', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ avatar: dataUrl }),
      });
      if (!uploaded.ok) throw new Error('上传失败（HTTP ' + uploaded.status + '）');
      const { avatar } = await uploaded.json();
      const patched = await fetch(SERVICE + '/api/bots/' + botId, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ avatar: avatar }),
      });
      if (!patched.ok) throw new Error('保存失败（HTTP ' + patched.status + '）');
      const body = await patched.json();
      return body.bot;
    }

    /** Switches a Bot's look; `null` puts it back on its skin after a custom avatar. */
    async function setSkin(botId, skin) {
      const patched = await fetch(SERVICE + '/api/bots/' + botId, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(skin === 'whale' ? { skin: skin, avatar: null } : { skin: skin, avatar: null }),
      });
      if (!patched.ok) throw new Error('保存失败（HTTP ' + patched.status + '）');
      const body = await patched.json();
      return body.bot;
    }

    /** Clears a custom avatar so the Bot shows its skin again. */
    async function clearAvatar(botId) {
      const patched = await fetch(SERVICE + '/api/bots/' + botId, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ avatar: null }),
      });
      if (!patched.ok) throw new Error('保存失败（HTTP ' + patched.status + '）');
      const body = await patched.json();
      return body.bot;
    }

    /** Opens the full team UI in the right-sidebar Browser tab (management: groups, memory, usage). */
    function openTeam(ctx) {
      try {
        const sidebar = ctx.get('sidebarRight');
        if (sidebar && typeof sidebar.openTab === 'function') {
          sidebar.openTab('browser', { params: { url: UI_URL } });
          return;
        }
      } catch (error) {
        // No sidebar Browser in this profile.
      }
      try { window.open(UI_URL, '_blank', 'noopener'); } catch (error) { /* nothing else to try */ }
    }

    const BORDER = '1px solid var(--dsw-alias-border-2, rgba(127,127,127,.25))';
    const SOFT = 'var(--dsw-alias-bg-2, rgba(127,127,127,.07))';
    const MUTED = 'var(--dsw-alias-text-3, #8b949e)';

    const S = {
      page: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
      head: { display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: BORDER },
      headTitle: { fontSize: 15, fontWeight: 600, margin: 0 },
      sub: { fontSize: 11, color: MUTED },
      body: { flex: 1, minHeight: 0, display: 'flex' },
      list: { width: 216, flex: '0 0 216px', borderRight: BORDER, overflowY: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 4 },
      listRow: (active) => ({ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px', borderRadius: 8, cursor: 'pointer',
        background: active ? 'var(--dsw-alias-bg-3, rgba(127,127,127,.16))' : 'transparent', border: 'none', width: '100%', textAlign: 'left', color: 'inherit' }),
      smallAvatar: { width: 24, height: 24, borderRadius: 7, objectFit: 'contain', background: SOFT, flex: '0 0 24px' },
      rowName: { fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      main: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },
      chatHead: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: BORDER },
      log: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10 },
      bubbleUser: { alignSelf: 'flex-end', maxWidth: '78%', padding: '9px 12px', borderRadius: '12px 12px 4px 12px',
        background: 'var(--dsw-alias-accent-bg, #4c72f5)', color: '#fff', fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      bubbleBot: { alignSelf: 'flex-start', maxWidth: '82%', padding: '9px 12px', borderRadius: '12px 12px 12px 4px',
        background: SOFT, border: BORDER, fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      meta: { fontSize: 10, color: MUTED, marginTop: 3 },
      tool: { fontSize: 11, color: MUTED, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', marginTop: 4 },
      composer: { borderTop: BORDER, padding: 12, display: 'flex', gap: 8, alignItems: 'flex-end' },
      text: { flex: 1, minHeight: 38, maxHeight: 160, resize: 'none', padding: '9px 10px', borderRadius: 10, border: BORDER,
        background: 'var(--dsw-alias-bg-1, transparent)', color: 'inherit', fontSize: 13, fontFamily: 'inherit', lineHeight: 1.5 },
      send: { height: 38, padding: '0 16px', borderRadius: 10, border: 'none', background: 'var(--dsw-alias-accent-bg, #4c72f5)', color: '#fff', fontSize: 13, cursor: 'pointer' },
      stop: { height: 38, padding: '0 14px', borderRadius: 10, border: BORDER, background: SOFT, color: 'inherit', fontSize: 13, cursor: 'pointer' },
      ghost: { height: 28, padding: '0 10px', borderRadius: 8, border: BORDER, background: 'transparent', color: 'inherit', fontSize: 12, cursor: 'pointer' },
      ghostOn: { height: 28, padding: '0 10px', borderRadius: 8, border: BORDER, background: 'var(--dsw-alias-bg-3, rgba(127,127,127,.18))', color: 'inherit', fontSize: 12, cursor: 'pointer', fontWeight: 600 },
      frame: { flex: 1, width: '100%', height: '100%', minHeight: 0, border: 'none', display: 'block', background: '#fff' },
      empty: { margin: 'auto', textAlign: 'center', color: MUTED, fontSize: 13, lineHeight: 1.8 },
    };

    function statusDot(alive) {
      return h('span', { style: { width: 7, height: 7, borderRadius: 4, display: 'inline-block', flex: '0 0 7px',
        background: alive ? 'var(--dsw-alias-accent, #3fb950)' : MUTED } });
    }

    /** Opening prompts for a Bot that has no history yet. */
    function Suggestions(props) {
      const picks = ['团队里有谁？', '你是谁？介绍一下你自己', '帮我写一句产品 slogan'];
      return h('div', { style: { margin: 'auto', maxWidth: 420, textAlign: 'center' } },
        h('div', { style: { fontSize: 13, color: MUTED, lineHeight: 1.8, marginBottom: 12 } },
          '和 ' + props.name + ' 的对话从这里开始。'),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          picks.map((text, index) => h('button', {
            key: index,
            type: 'button',
            style: { padding: '8px 12px', borderRadius: 10, border: BORDER, background: SOFT, color: 'inherit', fontSize: 13, cursor: 'pointer', textAlign: 'left' },
            onClick: () => props.onPick(text),
          }, text))));
    }

    function textOfMessage(message) {
      if (message.text) return message.text;
      const parts = Array.isArray(message.parts) ? message.parts : [];
      return parts.filter((part) => part.type === 'text' && part.text).map((part) => part.text).join('\n\n');
    }

    function toolsOfMessage(message) {
      const parts = Array.isArray(message.parts) ? message.parts : [];
      return parts.filter((part) => part.type === 'tool');
    }

    function MessageView(props) {
      const message = props.message;
      const bot = props.bot;
      const role = message.role;
      const when = message.ts ? new Date(message.ts) : undefined;
      const stamp = when && !Number.isNaN(when.getTime())
        ? String(when.getHours()).padStart(2, '0') + ':' + String(when.getMinutes()).padStart(2, '0')
        : '';
      if (role === 'system') {
        return h('div', { style: { alignSelf: 'center', fontSize: 11, color: MUTED } }, textOfMessage(message));
      }
      if (role === 'user') {
        return h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end' } },
          h('div', { style: S.bubbleUser }, textOfMessage(message)),
          stamp ? h('div', { style: S.meta }, stamp) : null);
      }
      const streaming = message.status === 'streaming';
      const failed = message.status === 'error';
      const tools = toolsOfMessage(message);
      const body = textOfMessage(message);
      const children = [h('div', { key: 'text', style: { whiteSpace: 'pre-wrap' } }, body || (streaming ? '…' : ''))];
      if (tools.length) {
        children.push(h('div', { key: 'tools', style: S.tool },
          tools.map((tool, index) => h('div', { key: index }, '⚙ ' + String(tool.name || '').replace('mcp__bot-team__', '') + (tool.state === 'ok' ? ' ✓' : tool.state === 'failed' ? ' ✕' : ' …')))));
      }
      if (failed) children.push(h('div', { key: 'err', style: Object.assign({}, S.meta, { color: 'var(--dsw-alias-danger, #f85149)' }) }, '这一轮失败了'));
      return h('div', { style: { display: 'flex', gap: 8, maxWidth: '82%' } },
        h('img', { src: botImage(bot), alt: '', draggable: false, style: S.smallAvatar }),
        h('div', null,
          h('div', { style: S.bubbleBot }, children),
          h('div', { style: S.meta },
            [stamp, message.durationMs ? Math.round(message.durationMs) + ' ms' : '', streaming ? '回复中…' : '']
              .filter(Boolean).join(' · '))));
    }

    function ChatView(props) {
      const bot = props.bot;
      const [messages, setMessages] = React.useState([]);
      const [draft, setDraft] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const [avatarNote, setAvatarNote] = React.useState('');
      const fileRef = React.useRef(null);
      const logRef = React.useRef(null);

      React.useEffect(() => {
        let cancelled = false;
        const load = () => {
          fetch(chatUrl(bot.id) + '?limit=120')
            .then((response) => (response.ok ? response.json() : Promise.reject(new Error('HTTP ' + response.status))))
            .then((page) => {
              if (cancelled) return;
              const list = Array.isArray(page.messages) ? page.messages : [];
              setMessages(list);
              setBusy(list.some((message) => message.role === 'bot' && message.status === 'streaming'));
              setError('');
            })
            .catch((failure) => { if (!cancelled) setError(String(failure && failure.message ? failure.message : failure)); });
        };
        load();
        const timer = setInterval(load, 1200);
        return () => { cancelled = true; clearInterval(timer); };
      }, [bot.id]);

      React.useEffect(() => {
        const node = logRef.current;
        if (node) node.scrollTop = node.scrollHeight;
      }, [messages.length, busy]);

      const send = () => {
        const text = draft.trim();
        if (!text || busy) return;
        setDraft('');
        setBusy(true);
        fetch(chatUrl(bot.id), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: text }),
        })
          .then((response) => { if (!response.ok && response.status !== 202) throw new Error('HTTP ' + response.status); })
          .catch((failure) => { setError(String(failure && failure.message ? failure.message : failure)); setBusy(false); });
      };

      const stop = () => {
        fetch(cancelUrl(bot.id), { method: 'POST' }).catch(() => {});
        setBusy(false);
      };

      const onKeyDown = (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          send();
        }
      };

      const logChildren = messages.length
        ? messages.map((message) => h(MessageView, { key: message.id, message: message, bot: bot }))
        : [h(Suggestions, { key: 'empty', name: bot.name, onPick: (text) => setDraft(text) })];

      const clear = () => {
        if (busy) return;
        fetch(SERVICE + '/api/chats/bot:' + bot.id + '/reset', { method: 'POST' })
          .then(() => setMessages([]))
          .catch(() => {});
      };

      const onPickFile = (event) => {
        const file = event.target.files && event.target.files[0];
        event.target.value = '';
        if (!file) return;
        setAvatarNote('上传中…');
        resizeToDataUrl(file)
          .then((dataUrl) => uploadAvatar(bot.id, dataUrl))
          .then(() => { setAvatarNote(''); props.onChanged(); })
          .catch((error) => setAvatarNote(String(error && error.message ? error.message : error)));
      };

      const onPickSkin = (event) => {
        const skin = event.target.value;
        setAvatarNote('');
        setSkin(bot.id, skin)
          .then(() => props.onChanged())
          .catch((error) => setAvatarNote(String(error && error.message ? error.message : error)));
      };

      const resetLook = () => {
        clearAvatar(bot.id).then(() => props.onChanged()).catch(() => {});
      };

      const avatarButton = h('button', {
        type: 'button',
        title: '点击换头像（上传自己的图片）',
        style: { padding: 0, border: 'none', background: 'transparent', cursor: 'pointer', lineHeight: 0 },
        onClick: () => { if (fileRef.current) fileRef.current.click(); },
      }, h('img', { src: botImage(bot), alt: '', draggable: false, style: { width: 28, height: 28, borderRadius: 8, objectFit: 'contain', background: SOFT } }));

      const skinSelect = h('select', {
        value: bot.skin || 'whale',
        title: '换皮肤',
        style: { height: 28, borderRadius: 8, border: BORDER, background: SOFT, color: 'inherit', fontSize: 12, padding: '0 6px' },
        onChange: onPickSkin,
      }, SKINS.map((entry) => h('option', { key: entry[0], value: entry[0] }, entry[1])));

      return h('div', { style: S.main },
        h('input', { ref: fileRef, type: 'file', accept: 'image/*', style: { display: 'none' }, onChange: onPickFile }),
        h('div', { style: S.chatHead },
          avatarButton,
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { style: { fontSize: 14, fontWeight: 600 } }, bot.name),
            h('div', { style: S.sub }, (bot.role || '未设置角色') + (busy ? ' · 正在回复…' : '') + (avatarNote ? ' · ' + avatarNote : ''))),
          skinSelect,
          bot.avatar ? h('button', { type: 'button', style: S.ghost, onClick: resetLook, title: '去掉自定义头像，回到皮肤' }, '恢复皮肤') : null,
          h('button', { type: 'button', style: S.ghost, onClick: clear, title: '清空这个 Bot 的聊天记录' }, '清空'),
          h('button', { type: 'button', style: S.ghost, onClick: props.onOpenUi }, '完整界面')),
        h('div', { ref: logRef, style: S.log }, logChildren),
        error ? h('div', { style: Object.assign({}, S.meta, { padding: '0 18px 6px', color: 'var(--dsw-alias-danger, #f85149)' }) }, error) : null,
        h('div', { style: S.composer },
          h('textarea', {
            value: draft,
            style: S.text,
            placeholder: '和 ' + bot.name + ' 说点什么…（Enter 发送，Shift+Enter 换行）',
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: onKeyDown,
            rows: 1,
          }),
          busy
            ? h('button', { type: 'button', style: S.stop, onClick: stop }, '停止')
            : h('button', { type: 'button', style: S.send, onClick: send }, '发送')));
    }

    /** The page the left-sidebar row selects. */
    function BotTeamPanel(props) {
      const ctx = props && props.ctx;
      const [status, setStatus] = React.useState({ phase: 'loading' });
      const [selected, setSelected] = React.useState(null);
      // The full team UI is the default view: everything (chat, groups, memory, tasks, usage,
      // skins, avatar upload) lives in one panel, with no extra window to open.
      const [mode, setMode] = React.useState('ui');
      const [frameToken, setFrameToken] = React.useState(0);

      const load = React.useCallback(() => {
        fetch(STATE_URL)
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error('HTTP ' + response.status))))
          .then((value) => {
            setStatus({ phase: 'ready', value: value });
            setSelected((current) => {
              if (current) {
                const fresh = (value.bots || []).find((bot) => bot.id === current.id);
                return fresh || current;
              }
              return (value.bots || [])[0] || null;
            });
          })
          .catch((failure) => setStatus({ phase: 'error', message: String(failure && failure.message ? failure.message : failure) }));
      }, []);

      React.useEffect(() => {
        load();
        const timer = setInterval(load, 5000);
        return () => clearInterval(timer);
      }, [load]);

      const ready = status.phase === 'ready';
      const value = status.value || {};
      const bots = Array.isArray(value.bots) ? value.bots : [];

      const listChildren = bots.length
        ? bots.map((bot) => h('button', {
          key: bot.id,
          type: 'button',
          style: S.listRow(Boolean(selected) && selected.id === bot.id),
          onClick: () => setSelected(bot),
        },
        h('img', { src: botImage(bot), alt: '', draggable: false, style: S.smallAvatar }),
        h('span', { style: S.rowName }, bot.name + (bot.isMain ? ' · 主' : ''))))
        : [h('div', { key: 'none', style: Object.assign({}, S.sub, { padding: 8 }) }, '没有 Bot')];

      const header = h('div', { style: S.head },
        h(Whale, { size: 20 }),
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('h1', { style: S.headTitle }, 'Dsh bot'),
          h('div', { style: S.sub },
            !ready ? (status.phase === 'loading' ? '连接团队服务…' : '团队服务未连接 · ' + (status.message || ''))
              : bots.length + ' 个 Bot · 127.0.0.1:8790' + (Array.isArray(value.groups) && value.groups.length ? ' · ' + value.groups.length + ' 个群' : ''))),
        statusDot(ready),
        h('button', {
          type: 'button',
          style: mode === 'chat' ? S.ghostOn : S.ghost,
          onClick: () => setMode('chat'),
          title: '在面板里用更轻的原生聊天',
        }, '聊天'),
        h('button', {
          type: 'button',
          style: mode === 'ui' ? S.ghostOn : S.ghost,
          onClick: () => setMode('ui'),
          title: '完整团队界面：群聊、记忆、任务、用量、皮肤与头像',
        }, '完整界面'),
        h('button', { type: 'button', style: S.ghost, onClick: () => setFrameToken((count) => count + 1), title: '重新加载' }, '刷新'),
        h('button', { type: 'button', style: S.ghost, onClick: () => openTeam(ctx), title: '在右侧边栏或新标签页打开' }, '↗'));

      const bodyView = mode === 'ui'
        ? h('iframe', {
          key: frameToken,
          src: UI_URL,
          title: 'Dsh bot 完整界面',
          style: S.frame,
        })
        : h('div', { style: S.body },
          h('div', { style: S.list }, listChildren),
          selected
            ? h(ChatView, { bot: selected, onOpenUi: () => openTeam(ctx), onChanged: load })
            : h('div', { style: S.empty }, '选择左边的一个 Bot 开始聊天。'));

      return h('div', { style: S.page }, header, bodyView);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // The row sits with 插件 / Superagent / 自动化任务 in the left sidebar.
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'dsh-bot-team',
          order: 30,
          label: 'Dsh bot',
        }, (props) => {
          const options = props || {};
          return h('span', { style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center' } },
            h(Whale, { size: options.size || 16, active: options.active }));
        }));
        // The same id keys the page that row selects in the layout's main slot.
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'dsh-bot-team',
        }, (props) => h(BotTeamPanel, Object.assign({}, props, { ctx: ctx }))));
      },
    };
  },
});
