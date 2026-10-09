/**
 * The few extension APIs the panel uses, typed by hand rather than pulling in
 * all of @types/chrome.
 */
declare namespace chrome {
  // `debugger` is a reserved word, so it is declared under another name and exported as itself.
  export namespace _debugger {
    interface Debuggee {
      tabId?: number;
    }
    function attach(target: Debuggee, requiredVersion: string): Promise<void>;
    function detach(target: Debuggee): Promise<void>;
    function sendCommand(
      target: Debuggee,
      method: string,
      commandParams?: Record<string, unknown>,
    ): Promise<unknown>;
    const onDetach: {
      addListener(callback: (source: Debuggee, reason: string) => void): void;
    };
  }

  export { _debugger as debugger };

  export namespace runtime {
    const lastError: { message?: string } | undefined;
    function getManifest(): { version: string };
  }

  export namespace devtools {
    namespace inspectedWindow {
      const tabId: number;
      // biome-ignore lint/suspicious/noShadowRestrictedNames: the API's real name.
      function eval(
        expression: string,
        callback?: (
          result: unknown,
          problem?: {
            /** The expression threw; `value` is what it threw. */
            isException?: boolean;
            value?: string;
            /** DevTools refused to run it; `details` says why ("Permission denied"). */
            isError?: boolean;
            details?: unknown[];
          },
        ) => void,
      ): void;
    }
    namespace panels {
      const themeName: 'default' | 'dark' | string;
      interface ExtensionPanel {
        onShown: { addListener(callback: (window: Window) => void): void };
        onHidden: { addListener(callback: () => void): void };
      }
      function create(
        title: string,
        iconPath: string,
        pagePath: string,
        callback?: (panel: ExtensionPanel) => void,
      ): void;
    }
    namespace network {
      const onNavigated: { addListener(callback: (url: string) => void): void };
    }
  }
}

/** Filled in at build time. */
declare const __ANALYZER_SCRIPT__: string;
declare const __VERSION__: string;
