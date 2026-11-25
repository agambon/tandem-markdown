// The smallest stand-in for the parts of VS Code that conflictFiles.ts reaches, for the tests that
// run it in Node: `vi.mock('vscode', () => import('./vscodeStandIn'))`. Other host tests take
// `Uri` or `Disposable` from it and add only what they need. `__state` holds the open
// documents and the workspace folder a test sets, what a file's stat answers and what it holds,
// and the listeners conflictFiles.ts registers, which a test calls to play VS Code's events.

export class Uri {
  constructor(
    readonly scheme: string,
    readonly path: string,
  ) {}
  static file(p: string): Uri {
    const slashed = p.replace(/\\/g, '/');
    return new Uri('file', slashed.startsWith('/') ? slashed : `/${slashed}`);
  }
  static joinPath(base: Uri, ...parts: string[]): Uri {
    return new Uri(base.scheme, [base.path, ...parts].join('/'));
  }
  static parse(s: string): Uri {
    const m = /^(\w+):\/\/(.*)$/.exec(s)!;
    return new Uri(m[1]!, m[2]!);
  }
  get fsPath(): string {
    return process.platform === 'win32' ? this.path.slice(1).replace(/\//g, '\\') : this.path;
  }
  with(change: { path?: string }): Uri {
    return new Uri(this.scheme, change.path ?? this.path);
  }
  toString(): string {
    return `${this.scheme}://${this.path}`;
  }
}

const disposable = { dispose: () => undefined };
const event = () => disposable;

export class EventEmitter<T> {
  private readonly listeners: ((value: T) => void)[] = [];
  readonly event = (listener: (value: T) => void) => {
    this.listeners.push(listener);
    return disposable;
  };
  fire(value: T): void {
    for (const l of this.listeners) l(value);
  }
  dispose(): void {}
}

export class Disposable {
  constructor(private readonly done: () => void) {}
  static from(...items: unknown[]): Disposable {
    return new Disposable(() => {
      for (const item of items) (item as { dispose?: () => void } | null)?.dispose?.();
    });
  }
  dispose(): void {
    this.done();
  }
}

export const __state = {
  documents: [] as unknown[],
  folder: null as unknown,
  focus: null as null | ((s: { focused: boolean }) => void),
  renamed: null as null | ((e: { files: { oldUri: unknown; newUri: unknown }[] }) => void),
  deleted: null as null | ((e: { files: unknown[] }) => void),
  edited: null as null | ((e: unknown) => void),
  watcherDeleted: null as null | ((uri: unknown) => void),
  /** Each warning message shown, with its buttons; none is ever answered. */
  warnings: [] as { message: string; items: string[] }[],
  /** What `workspace.fs.stat` answers for a path: `file`, or the code of the error it throws (none set: FileNotFound). */
  stats: new Map<string, string>(),
  /** The bytes `workspace.fs.readFile` reads, by path; a path not here is not found. */
  files: new Map<string, Uint8Array>(),
};

export const workspace = {
  get textDocuments() {
    return __state.documents;
  },
  getWorkspaceFolder: () => __state.folder,
  getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
  createFileSystemWatcher: () => ({
    onDidDelete: (listener: (uri: unknown) => void) => {
      __state.watcherDeleted = listener;
      return disposable;
    },
    dispose: () => undefined,
  }),
  onDidOpenTextDocument: event,
  onDidCloseTextDocument: event,
  onDidChangeTextDocument: (listener: (e: unknown) => void) => {
    __state.edited = listener;
    return disposable;
  },
  onDidRenameFiles: (listener: (e: { files: { oldUri: unknown; newUri: unknown }[] }) => void) => {
    __state.renamed = listener;
    return disposable;
  },
  onDidDeleteFiles: (listener: (e: { files: unknown[] }) => void) => {
    __state.deleted = listener;
    return disposable;
  },
  fs: {
    stat: async (uri: { fsPath: string }) => {
      const answer = __state.stats.get(uri.fsPath) ?? 'FileNotFound';
      if (answer !== 'file') throw Object.assign(new Error(answer), { code: answer });
      return { type: 1 };
    },
    readFile: async (uri: { fsPath: string }) => {
      const bytes = __state.files.get(uri.fsPath);
      if (bytes === undefined) throw Object.assign(new Error('FileNotFound'), { code: 'FileNotFound' });
      return bytes;
    },
  },
};

export const window = {
  state: { focused: true },
  tabGroups: { activeTabGroup: { activeTab: undefined }, all: [], onDidChangeTabs: event },
  onDidChangeWindowState: (listener: (s: { focused: boolean }) => void) => {
    __state.focus = listener;
    return disposable;
  },
  showWarningMessage: (message: string, ...items: string[]) => {
    __state.warnings.push({ message, items });
    return new Promise<undefined>(() => undefined);
  },
  showInformationMessage: (message: string, ...items: string[]) => {
    __state.warnings.push({ message, items });
    return new Promise<undefined>(() => undefined);
  },
  showErrorMessage: (message: string, ...items: string[]) => {
    __state.warnings.push({ message, items });
    return new Promise<undefined>(() => undefined);
  },
};
