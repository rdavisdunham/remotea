import fs from 'fs';
import os from 'os';
import path from 'path';
import { isDeepStrictEqual } from 'util';
import type { IntegrationFileState, IntegrationFileStatus, IntegrationStatus } from '../shared/integration-status';
import { integrationErrorCode, integrationFailures } from './integration-failures';
import { readRenderedInstructions } from './agent-instructions';
import {
  applyWmuxHooks,
  removeWmuxHooks,
  getClaudeMdPath,
  getHookScriptPath,
  buildChromeDevtoolsMcpServer,
} from './claude-context';
import { getPluginSrcPath } from './opencode-context';
import { getKiroSteeringPath } from './kiro-context';
import { getOmpAgentsMdPath, getOmpExtensionPath, getOmpExtensionSrcPath } from './omp-context';
import { getPiContextFilePath, getPiExtensionPath, getPiExtensionSrcPath } from './pi-context';
import { getGrokRulesPath, getGrokHooksPath, buildGrokHooks, grokReadsClaudeContext } from './grok-context';
import { getAgyPluginDir, getHookScriptSrcPath, buildAgyPluginManifest, buildAgyHooks } from './agy-context';
import {
  getQwenContextPath,
  getQwenSettingsPath,
  applyQwenHooks,
  removeQwenHooksFrom,
  qwenHookStubSource,
  QWEN_HOOK_STUB,
} from './qwen-context';

interface FileProbe extends Omit<IntegrationFileStatus, 'state' | 'code'> {
  inspect: (content: string) => IntegrationFileState;
}

function json(content: string): Record<string, any> {
  const value = JSON.parse(content);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error(), { code: 'INVALID_JSON_OBJECT' });
  }
  return value;
}

function contextState(content: string): IntegrationFileState {
  const start = content.indexOf('<!-- wmux:start');
  if (start < 0) return 'missing';
  const end = content.indexOf('<!-- wmux:end -->', start);
  if (end < 0) return 'modified';
  const expected = readRenderedInstructions();
  if (expected === null) throw Object.assign(new Error(), { code: 'RESOURCE_MISSING' });
  const actual = content.slice(start, end + '<!-- wmux:end -->'.length);
  return actual.trim() === expected.trim() ? 'present' : 'modified';
}

const exactFile = (source: () => string) => (content: string): IntegrationFileState =>
  content === fs.readFileSync(source(), 'utf8') ? 'present' : 'modified';
const exactJson = (expected: () => unknown) => (content: string): IntegrationFileState =>
  isDeepStrictEqual(json(content), expected()) ? 'present' : 'modified';

function hooksState(
  apply: (value: unknown, hook: string) => unknown,
  remove: (value: unknown) => unknown,
  hookScript: () => string = getHookScriptPath,
): FileProbe['inspect'] {
  return content => {
    const value = json(content);
    if (isDeepStrictEqual(value, remove(value))) return 'missing';
    return isDeepStrictEqual(value, apply(value, hookScript())) ? 'present' : 'modified';
  };
}

function mcpState(content: string): IntegrationFileState {
  const entry = json(content).mcpServers?.['chrome-devtools'];
  if (!entry) return 'missing';
  return isDeepStrictEqual(entry, buildChromeDevtoolsMcpServer()) ? 'present' : 'modified';
}

/** Read-only: no agent processes, network calls, writes or credential values leave this function. */
export function readIntegrationStatus(): IntegrationStatus {
  const home = os.homedir();
  const agy = getAgyPluginDir(home);
  const qwenStub = () => path.join(path.dirname(getQwenSettingsPath()), QWEN_HOOK_STUB);
  const qwenHooks = hooksState(
    applyQwenHooks,
    removeQwenHooksFrom,
    () => qwenStub().split(path.sep).join('/'),
  );
  const files: FileProbe[] = [
    {
      provider: 'Claude Code',
      feature: 'instructions',
      path: getClaudeMdPath(),
      inspect: contextState,
    },
    {
      provider: 'Claude Code',
      feature: 'hooks',
      path: path.join(home, '.claude/settings.json'),
      inspect: hooksState(applyWmuxHooks, removeWmuxHooks),
    },
    {
      provider: 'Claude Code',
      feature: 'browserMcp',
      path: path.join(home, '.claude.json'),
      inspect: mcpState,
    },
    {
      provider: 'Claude Code',
      feature: 'browserMcp',
      path: path.join(home, '.claude/settings.json'),
      inspect: content => {
        const flag = json(content).enabledPlugins?.['chrome-devtools-mcp@claude-plugins-official'];
        return flag === undefined ? 'missing' : flag === false ? 'present' : 'modified';
      },
    },
    {
      provider: 'OpenCode',
      feature: 'instructions',
      path: path.join(home, '.config/opencode/AGENTS.md'),
      inspect: contextState,
    },
    {
      provider: 'OpenCode',
      feature: 'orchestrator',
      path: path.join(home, '.config/opencode/plugin/wmux.js'),
      inspect: exactFile(getPluginSrcPath),
    },
    {
      provider: 'Kiro',
      feature: 'instructions',
      path: getKiroSteeringPath(),
      inspect: contextState,
    },
    {
      provider: 'omp',
      feature: 'instructions',
      path: getOmpAgentsMdPath(),
      inspect: contextState,
    },
    {
      provider: 'omp',
      feature: 'hooks',
      path: getOmpExtensionPath(),
      inspect: exactFile(getOmpExtensionSrcPath),
    },
    {
      provider: 'pi',
      feature: 'instructions',
      path: getPiContextFilePath(),
      inspect: contextState,
    },
    {
      provider: 'pi',
      feature: 'hooks',
      path: getPiExtensionPath(),
      inspect: exactFile(getPiExtensionSrcPath),
    },
    {
      provider: 'Grok',
      feature: 'instructions',
      path: grokReadsClaudeContext() ? getClaudeMdPath() : getGrokRulesPath(),
      inspect: contextState,
    },
    {
      provider: 'Grok',
      feature: 'hooks',
      path: getGrokHooksPath(),
      inspect: exactJson(() => buildGrokHooks(getHookScriptPath())),
    },
    {
      provider: 'Antigravity',
      feature: 'hooks',
      path: path.join(agy, 'plugin.json'),
      inspect: exactJson(() => json(buildAgyPluginManifest())),
    },
    {
      provider: 'Antigravity',
      feature: 'hooks',
      path: path.join(agy, 'hooks.json'),
      inspect: exactJson(() => json(buildAgyHooks())),
    },
    {
      provider: 'Antigravity',
      feature: 'hooks',
      path: path.join(agy, 'wmux-agy-hook.cjs'),
      inspect: exactFile(getHookScriptSrcPath),
    },
    {
      provider: 'Qwen Code',
      feature: 'instructions',
      path: getQwenContextPath(),
      inspect: contextState,
    },
    {
      provider: 'Qwen Code',
      feature: 'hooks',
      path: getQwenSettingsPath(),
      inspect: qwenHooks,
    },
    {
      provider: 'Qwen Code',
      feature: 'hooks',
      path: qwenStub(),
      inspect: content => content === qwenHookStubSource(getHookScriptPath()) ? 'present' : 'modified',
    },
    {
      provider: 'Qwen Code',
      feature: 'browserMcp',
      path: getQwenSettingsPath(),
      inspect: mcpState,
    },
  ];
  return {
    environment: 'desktop-user',
    checkedAt: Date.now(),
    runtime: 'not-probed',
    failures: integrationFailures(),
    files: files.map(({ inspect, ...file }) => {
      let content: string;
      try {
        content = fs.readFileSync(file.path, 'utf8');
      } catch (error) {
        const code = integrationErrorCode(error);
        return code === 'ENOENT'
          ? { ...file, state: 'missing' }
          : { ...file, state: 'error', code };
      }
      try {
        return { ...file, state: inspect(content) };
      } catch (error) {
        const code = integrationErrorCode(error);
        return {
          ...file,
          state: 'error',
          code: error instanceof SyntaxError
            ? 'INVALID_JSON'
            : code === 'ENOENT' ? 'RESOURCE_MISSING' : code,
        };
      }
    }),
  };
}
