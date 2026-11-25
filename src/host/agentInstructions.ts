// "Add Agent Instructions" (`tandemMarkdown.addAgentInstructions`), and its offer, made when a
// conflict file is written in a workspace until one of its buttons is pressed. Writes to AGENTS.md
// and .claude/rules/tandem-markdown.md; never touches CLAUDE.md or .gitignore.

import { lstat, mkdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { registerCommand } from './commandRegistration';
import type { HostFeature } from './features';
import { isMissing, writeWhole } from './localFiles';
import { log } from './log';
import { messages } from './messages';
import {
  type FailedWrite,
  agentsPlan,
  bytesKind,
  dialogDetail,
  leftAsItIs,
  leftReply,
  rulePlan,
  writtenReply,
} from './model/agentInstructions';
import * as W from './model/conflictFile';
import { COPY_INSTRUCTIONS, OPEN_AGENTS, messageForm } from './model/messageForms';
import { fill } from './model/templates';
import { askModal } from './questions';

const ANSWERED_KEY = 'tandemMarkdown.instructionsAnswered';

export interface AddResult {
  prompt?: { message: string; detail: string };
  reply?: string;
  written: string[];
}

let context: vscode.ExtensionContext | null = null;
let offering = false;

export const agentInstructions: HostFeature = (extensionContext) => {
  context = extensionContext;
  return registerCommand('addAgentInstructions', (folder) => addInstructions(folder, true));
};

interface FolderFiles {
  folder: vscode.WorkspaceFolder;
  agents: vscode.Uri;
  rule: vscode.Uri;
}

function filesOf(folder: vscode.WorkspaceFolder): FolderFiles {
  return {
    folder,
    agents: vscode.Uri.joinPath(folder.uri, W.AGENTS_FILE),
    rule: vscode.Uri.joinPath(folder.uri, ...W.RULE_FILE.split('/')),
  };
}

async function nothingIfMissing<T>(read: PromiseLike<T>): Promise<T | null> {
  try {
    return await read;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function readText(uri: vscode.Uri): Promise<string | null> {
  if (uri.scheme === 'file') return nothingIfMissing(readFile(uri.fsPath, 'utf8'));
  const bytes = await nothingIfMissing(vscode.workspace.fs.readFile(uri));
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

async function writeText(uri: vscode.Uri, text: string): Promise<void> {
  if (uri.scheme === 'file') {
    await mkdir(path.dirname(uri.fsPath), { recursive: true });
    await writeWhole(uri.fsPath, text);
    return;
  }
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

async function readFor<T extends object>(
  name: string,
  uri: vscode.Uri,
  read: (uri: vscode.Uri) => Promise<T>,
): Promise<T | { unreadable: FailedWrite }> {
  try {
    return await read(uri);
  } catch (error) {
    log('warn', `Could not read ${uri.fsPath}`, error);
    return { unreadable: { file: name, path: uri.fsPath, code: codeOf(error) } };
  }
}

async function plansFor(
  files: FolderFiles,
): Promise<{ agents: ReturnType<typeof agentsPlan>; rule: ReturnType<typeof rulePlan> } | { unreadable: FailedWrite }> {
  const agents = await readFor(W.AGENTS_FILE, files.agents, readAgents);
  if ('unreadable' in agents) return { unreadable: agents.unreadable };
  const rule = await readFor(W.RULE_FILE, files.rule, async (uri) => ({ text: await readText(uri) }));
  if ('unreadable' in rule) return { unreadable: rule.unreadable };
  return {
    agents: agents.kind !== null ? { place: agents.kind, text: '' } : agentsPlan(agents.text),
    rule: rulePlan(rule.text),
  };
}

async function readAgents(
  uri: vscode.Uri,
): Promise<{ text: string | null; kind: 'link' | 'linked' | 'notUtf8' | null }> {
  let bytes: Uint8Array | null = null;
  if (uri.scheme !== 'file') {
    bytes = await nothingIfMissing(vscode.workspace.fs.readFile(uri));
  } else {
    const info = await nothingIfMissing(lstat(uri.fsPath));
    if (info !== null) {
      if (info.isSymbolicLink()) return { text: null, kind: 'link' };
      if ((await stat(uri.fsPath)).nlink > 1) return { text: null, kind: 'linked' };
      bytes = await readFile(uri.fsPath);
    }
  }
  if (bytes === null) return { text: null, kind: null };
  const kind = bytesKind(bytes);
  return { text: kind === null ? new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) : null, kind };
}

async function folderHasInstructions(folder: vscode.WorkspaceFolder): Promise<boolean> {
  const plans = await plansFor(filesOf(folder));
  return !('unreadable' in plans) && plans.agents.place === 'has' && plans.rule.place === 'has';
}

async function chooseFolder(arg: unknown): Promise<vscode.WorkspaceFolder | undefined> {
  if (arg && typeof arg === 'object' && 'uri' in arg && 'name' in arg) return arg as vscode.WorkspaceFolder;
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length <= 1) return folders[0];
  const picked = await vscode.window.showQuickPick(
    folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
    { placeHolder: W.WHICH_FOLDER },
  );
  return picked?.folder;
}

async function addInstructions(folderArg: unknown, ask: boolean): Promise<AddResult> {
  if ((vscode.workspace.workspaceFolders ?? []).length === 0) {
    messages.reply(W.OPEN_A_FOLDER, 'information');
    return { reply: W.OPEN_A_FOLDER, written: [] };
  }
  const folder = await chooseFolder(folderArg);
  if (!folder) return { written: [] };
  const files = filesOf(folder);
  const plans = await plansFor(files);
  if ('unreadable' in plans) return tellWritten(folder, [plans.unreadable], []);
  const left = leftReply(plans.agents.place, 'had');
  if (left !== null && plans.rule.place === 'has') return offerCopy(left);
  const detail = dialogDetail(plans.agents.place, plans.rule.place);
  if (detail === null) {
    messages.reply(W.ALREADY_BOTH, 'information');
    return { reply: W.ALREADY_BOTH, written: [] };
  }
  let prompt: AddResult['prompt'];
  if (ask) {
    const message = fill(W.ADD_TO_FOLDER, { folder: folder.name });
    prompt = { message, detail };
    if ((await askModal(message, detail, [W.ADD_THE_INSTRUCTIONS])) !== W.ADD_THE_INSTRUCTIONS)
      return { prompt, written: [] };
  }
  const asked = prompt ? { prompt } : {};

  const now = await plansFor(files);
  if ('unreadable' in now) return { ...asked, ...(await tellWritten(folder, [now.unreadable], [])) };
  const failed: FailedWrite[] = [];
  const written: string[] = [];
  const targets: [string, vscode.Uri, { place: string; text: string }][] = [
    [W.AGENTS_FILE, files.agents, now.agents],
    [W.RULE_FILE, files.rule, now.rule],
  ];
  for (const [name, uri, plan] of targets) {
    if (plan.place === 'has') {
      written.push(name);
      continue;
    }
    if (leftAsItIs(now.agents.place) !== null && name === W.AGENTS_FILE) continue;
    try {
      await writeText(uri, plan.text);
      written.push(name);
    } catch (error) {
      log('warn', `Could not write ${uri.fsPath}`, error);
      failed.push({ file: name, path: uri.fsPath, code: codeOf(error) });
    }
  }
  const leftNow = leftReply(now.agents.place, 'written');
  if (leftNow !== null && failed.length === 0) return { ...asked, ...offerCopy(leftNow, written) };
  return { ...asked, ...(await tellWritten(folder, failed, written)) };
}

function offerCopy(text: string, written: string[] = []): AddResult {
  messages.reply(text, 'information', [{ label: COPY_INSTRUCTIONS, run: copyInstructions }]);
  return { reply: text, written };
}

async function copyInstructions(): Promise<void> {
  await vscode.env.clipboard.writeText(W.INSTRUCTIONS);
  messages.reply(W.INSTRUCTIONS_COPIED, 'information');
}

async function tellWritten(
  folder: vscode.WorkspaceFolder,
  failed: FailedWrite[],
  written: string[],
): Promise<AddResult> {
  const reply = writtenReply(failed, folder.uri.fsPath, written);
  if (reply.onClipboard) await vscode.env.clipboard.writeText(W.INSTRUCTIONS);
  if (failed.length > 0) messages.reply(reply.text, 'warning');
  else
    messages.reply(reply.text, 'information', [
      { label: OPEN_AGENTS, run: () => vscode.commands.executeCommand('vscode.open', filesOf(folder).agents) },
    ]);
  return { reply: reply.text, written };
}

/** Offered when a conflict file is written in a workspace until answered or both files already have them. */
export async function offerInstructions(folder: vscode.WorkspaceFolder): Promise<void> {
  const workspace = context?.workspaceState;
  if (!workspace || offering || workspace.get<boolean>(ANSWERED_KEY)) return;
  offering = true;
  const answered = (): void => void workspace.update(ANSWERED_KEY, true);
  if (await folderHasInstructions(folder)) {
    answered();
    offering = false;
    return;
  }
  messages.open({
    id: `${ANSWERED_KEY}:${folder.uri.toString()}`,
    note: null,
    form: messageForm({ kind: 'instructionsOffer' }),
    offers: () => true,
    press: async (does) => {
      answered();
      if (does === 'addInstructions') await addInstructions(folder, false);
      else if (does === 'copyInstructions') await copyInstructions();
      return true;
    },
    closed: () => {
      offering = false;
    },
    last: true,
  });
}
