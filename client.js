/**
 * Client half of the power actions: two entries above Settings in the sidebar
 * foot.
 *
 * The restart entry needs a distinct confirming press because a restart
 * interrupts running tasks. The quit entry closes the application with a single
 * press, as requested, and only reports failures.
 */
window.__ModuleLoader__.load({
  id: 'dsh-restart-button',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NAMESPACE = 'dsh-restart-button';
    const STATUS_ENDPOINT = '/dsh-restart/status';
    const RESTART_ENDPOINT = '/dsh-restart/restart';
    const QUIT_ENDPOINT = '/dsh-restart/quit';
    const ARM_TIMEOUT_MS = 5000;
    const ARM_DELAY_MS = 400;
    const ERROR_TIMEOUT_MS = 6000;
    const PENDING_TIMEOUT_MS = 20000;

    const DICTIONARIES = {
      en: {
        action: 'Restart',
        arm: 'Confirm restart',
        pending: 'Restarting…',
        hint: 'Restart DeepSeek Harness so installed or removed plugins take effect.',
        consequence: 'Running tasks are interrupted. Press again to restart.',
        failed: 'Restart failed',
        quit: 'Quit',
        quitting: 'Quitting…',
        quitFailed: 'Quit failed',
        quitHint: 'Close DeepSeek Harness completely, including its Host and child processes. Running tasks are interrupted.',
      },
      zh: {
        action: '重启',
        arm: '确认重启',
        pending: '正在重启…',
        hint: '重启 DeepSeek Harness，让安装或卸载的插件生效。',
        consequence: '正在运行的任务会中断。再次点击即可重启。',
        failed: '重启失败',
        quit: '关机',
        quitting: '正在关闭…',
        quitFailed: '关闭失败',
        quitHint: '彻底关闭 DeepSeek Harness（包括 Host 与子进程）。正在运行的任务会中断。',
      },
    };

    const STYLE = `
.dshrb-action{display:inline-flex;align-items:center;gap:var(--dsh-sidebar-label-gap,6px);width:100%;height:42px;padding:0 calc(12px - var(--dsh-sidebar-paint-inset,3px));border:0;border-radius:var(--dsw-radius-md,12px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:1.2;text-align:left;cursor:pointer}
.dshrb-action[data-rail='true']{width:36px;height:36px;padding:0;justify-content:center}
.dshrb-action:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.dshrb-action:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary)));outline-offset:2px}
.dshrb-action[data-tone='warn'] .dshrb-label,.dshrb-action[data-tone='warn'] .dshrb-icon{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary))}
.dshrb-action[data-tone='error'] .dshrb-label,.dshrb-action[data-tone='error'] .dshrb-icon{color:var(--dsw-alias-state-error-primary)}
.dshrb-action[aria-disabled='true']{cursor:progress}
.dshrb-icon{display:block;flex:none;width:16px;height:16px}
.dshrb-action[data-rail='true'] .dshrb-icon{width:18px;height:18px}
.dshrb-icon[data-spin='true']{animation:dshrb-spin 1s linear infinite}
.dshrb-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshrb-dot{flex:none;width:6px;height:6px;border-radius:50%;background:currentColor}
.dshrb-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
@keyframes dshrb-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.dshrb-icon[data-spin='true']{animation:none}}
`;

    const useSyncExternalStore = React.useSyncExternalStore instanceof Function
      ? React.useSyncExternalStore
      : (subscribe, getSnapshot) => {
        const [, force] = React.useReducer((value) => value + 1, 0);
        React.useEffect(() => subscribe(force), [subscribe]);
        return getSnapshot();
      };

    function RestartGlyph(props) {
      return h('svg', {
        className: 'dshrb-icon',
        viewBox: '0 0 24 24',
        fill: 'none',
        'data-spin': props.spinning ? 'true' : 'false',
        'aria-hidden': 'true',
      },
      h('path', {
        d: 'M20 12a8 8 0 1 1-2.34-5.66',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
      }),
      h('path', {
        d: 'M20 4v4.5h-4.5',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }));
    }

    function PowerGlyph(props) {
      return h('svg', {
        className: 'dshrb-icon',
        viewBox: '0 0 24 24',
        fill: 'none',
        'data-spin': props.spinning ? 'true' : 'false',
        'aria-hidden': 'true',
      },
      h('path', {
        d: 'M16.93 5.7A8 8 0 1 1 7.07 5.7',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
      }),
      h('path', {
        d: 'M12 3v7',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
      }));
    }

    /**
     * Build one action component bound to this client context.
     * @param ctx - client plugin context with `slots` and `locale`.
     * @param options - endpoint, wording keys, glyph, and whether a press must be confirmed.
     * @returns the React component registered into the sidebar footer seat.
     */
    function createPowerAction(ctx, options) {
      const translate = ctx.locale.bind(NAMESPACE);
      const subscribe = (onChange) => ctx.locale.subscribe(onChange);
      const getSnapshot = () => ctx.locale.getSnapshot();
      const Glyph = options.glyph === 'power' ? PowerGlyph : RestartGlyph;

      function PowerAction(props) {
        useSyncExternalStore(subscribe, getSnapshot);
        const [supported, setSupported] = React.useState(null);
        const [phase, setPhase] = React.useState('idle');
        const armedAt = React.useRef(0);

        React.useEffect(() => {
          let alive = true;
          const retry = (attempt) => {
            if (!alive) return;
            if (attempt > 4) {
              setSupported(true);
              return;
            }
            setTimeout(() => readStatus(attempt), 1000 * attempt);
          };
          const readStatus = (attempt) => {
            fetch(STATUS_ENDPOINT, { headers: { accept: 'application/json' } })
              .then((response) => {
                if (!response.ok) {
                  retry(attempt + 1);
                  return null;
                }
                return response.json();
              })
              .then((state) => {
                if (!alive || state === null) return;
                setSupported(state.supported === true);
              })
              .catch(() => retry(attempt + 1));
          };
          readStatus(1);
          return () => { alive = false; };
        }, []);

        React.useEffect(() => {
          if (phase === 'idle' || phase === 'pending') return undefined;
          const timeout = setTimeout(() => setPhase('idle'), phase === 'arm' ? ARM_TIMEOUT_MS : ERROR_TIMEOUT_MS);
          return () => clearTimeout(timeout);
        }, [phase]);

        React.useEffect(() => {
          if (phase !== 'pending') return undefined;
          const timeout = setTimeout(() => setPhase('error'), PENDING_TIMEOUT_MS);
          return () => clearTimeout(timeout);
        }, [phase]);

        React.useEffect(() => {
          if (phase !== 'arm') return undefined;
          const cancel = (event) => {
            if (event.type === 'keydown' && event.key !== 'Escape') return;
            setPhase('idle');
          };
          window.addEventListener('keydown', cancel);
          window.addEventListener('blur', cancel);
          return () => {
            window.removeEventListener('keydown', cancel);
            window.removeEventListener('blur', cancel);
          };
        }, [phase]);

        if (supported !== true) return null;

        const rail = props.wide !== true;
        const busy = phase === 'sending' || phase === 'pending';
        const label = phase === 'arm'
          ? translate(options.armKey)
          : phase === 'sending' || phase === 'pending'
            ? translate(options.pendingKey)
            : phase === 'error'
              ? translate(options.failedKey)
              : translate(options.actionKey);
        const hint = phase === 'arm'
          ? translate(options.consequenceKey ?? options.hintKey)
          : phase === 'error'
            ? translate(options.failedKey)
            : translate(options.hintKey);
        const tone = phase === 'error' ? 'error' : phase === 'arm' ? 'warn' : undefined;

        const send = () => {
          setPhase('sending');
          fetch(options.endpoint, {
            method: 'POST',
            headers: { 'x-dsh-restart-request': '1', accept: 'application/json' },
          }).then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            setPhase('pending');
          }).catch(() => {
            setPhase('error');
          });
        };

        const activate = (event) => {
          if (event.repeat) return;
          if (busy) return;
          if (options.confirm) {
            if (phase === 'idle' || phase === 'error') {
              armedAt.current = Date.now();
              setPhase('arm');
              return;
            }
            if (phase !== 'arm') return;
            // A double click arms and confirms in one gesture; require a distinct
            // second press so an accidental double click cannot restart the app.
            if (Date.now() - armedAt.current < ARM_DELAY_MS) return;
            send();
            return;
          }
          if (phase === 'sending' || phase === 'pending') return;
          send();
        };

        return h(React.Fragment, null,
          h('style', null, STYLE),
          h('button', {
            type: 'button',
            className: 'dshrb-action',
            'data-tone': tone,
            'data-rail': rail ? 'true' : 'false',
            title: hint,
            'aria-label': label,
            'aria-busy': busy ? 'true' : undefined,
            'aria-disabled': busy ? 'true' : undefined,
            onClick: activate,
          },
          h(Glyph, { spinning: busy }),
          rail ? null : h('span', { className: 'dshrb-label' }, label),
          rail && phase === 'arm' ? h('span', { className: 'dshrb-dot', 'aria-hidden': 'true' }) : null),
          h('span', { className: 'dshrb-sr', role: 'status' }, label));
      }

      return PowerAction;
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const disposers = Object.entries(DICTIONARIES).map(([locale, dictionary]) =>
            ctx.locale.register(NAMESPACE, locale, dictionary));
          return () => { for (const dispose of disposers) dispose(); };
        });
        ctx.slots.inject('sidebar.footer.action', () => {
          const restart = ctx.slots.register({
            name: 'sidebar.footer.action',
            id: 'dsh-restart-button',
            order: 20,
            label: () => ctx.locale.bind(NAMESPACE)('action'),
          }, createPowerAction(ctx, {
            endpoint: RESTART_ENDPOINT,
            actionKey: 'action',
            armKey: 'arm',
            pendingKey: 'pending',
            failedKey: 'failed',
            hintKey: 'hint',
            consequenceKey: 'consequence',
            glyph: 'restart',
            confirm: true,
          }));
          const quit = ctx.slots.register({
            name: 'sidebar.footer.action',
            id: 'dsh-shutdown-button',
            order: 21,
            label: () => ctx.locale.bind(NAMESPACE)('quit'),
          }, createPowerAction(ctx, {
            endpoint: QUIT_ENDPOINT,
            actionKey: 'quit',
            pendingKey: 'quitting',
            failedKey: 'quitFailed',
            hintKey: 'quitHint',
            glyph: 'power',
            confirm: false,
          }));
          return () => {
            if (typeof restart === 'function') restart();
            if (typeof quit === 'function') quit();
          };
        });
      },
    };
  },
});
