// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';
import {execFileSync} from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import yaml from 'js-yaml';

export interface AndroidInternalsWikiArticle {
  relativePath: string;
  title?: string;
  status?: string;
  confidence?: string;
  lastVerified?: string;
  lastVerifiedAgainst?: string;
  tags: string[];
  body: string;
  /** Full Markdown hash, including frontmatter, for generation identity. */
  fileHash: string;
  /** Normalized body hash used only for duplicate-content detection. */
  contentHash: string;
  metadataValid: boolean;
  metadataError?: string;
}

export interface AndroidInternalsWikiCorpus {
  rootPath: string;
  totalArticles: number;
  articles: AndroidInternalsWikiArticle[];
  contentFingerprint: string;
}

export interface AndroidInternalsWikiCorpusIdentity {
  revision: string;
  contentFingerprint: string;
  dirtyAcceptedArticlePaths: string[];
  dirty: boolean;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function scalar(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*["']?([^#\\n"']+)`, 'm'));
  return match?.[1]?.trim() || undefined;
}

function listMarkdownFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  const files: string[] = [];
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const basename = entry.name.toUpperCase();
        if (basename !== 'README.MD' && basename !== 'SUMMARY.MD') files.push(fullPath);
      }
    }
  }
  return files.sort();
}

export function scanAndroidInternalsWiki(rootPath: string): AndroidInternalsWikiCorpus {
  const resolvedRoot = path.resolve(rootPath);
  const articles: AndroidInternalsWikiArticle[] = [];
  for (const filePath of listMarkdownFiles(path.join(resolvedRoot, 'src'))) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const frontmatterMatch = raw.match(FRONTMATTER);
    const relativePath = path.relative(resolvedRoot, filePath).split(path.sep).join('/');
    if (!frontmatterMatch) {
      articles.push({
        relativePath,
        tags: [],
        body: raw,
        fileHash: createHash('sha256').update(raw).digest('hex'),
        contentHash: createHash('sha256').update(raw.replace(/\s+/g, ' ').trim()).digest('hex'),
        metadataValid: false,
        metadataError: 'missing frontmatter',
      });
      continue;
    }
    const frontmatter = frontmatterMatch[1] ?? '';
    const body = raw.slice(frontmatterMatch[0].length);
    let parsed: Record<string, unknown> | null = null;
    let metadataError: string | undefined;
    try {
      const loaded = yaml.load(frontmatter);
      if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
        throw new Error('frontmatter must be a mapping');
      }
      parsed = loaded as Record<string, unknown>;
    } catch (error) {
      metadataError = error instanceof Error ? error.message : String(error);
    }
    const stringValue = (key: string): string | undefined => {
      const value = parsed?.[key];
      return typeof value === 'string' ? value.trim() || undefined : scalar(frontmatter, key);
    };
    const parsedTags = parsed?.tags;
    articles.push({
      relativePath,
      title: stringValue('title'),
      status: stringValue('status'),
      confidence: stringValue('confidence'),
      lastVerified: stringValue('last_verified'),
      lastVerifiedAgainst: stringValue('last_verified_against'),
      tags: Array.isArray(parsedTags)
        ? parsedTags.filter((tag): tag is string => typeof tag === 'string').map(tag => tag.trim())
        : [],
      body,
      fileHash: createHash('sha256').update(raw).digest('hex'),
      contentHash: createHash('sha256').update(body.replace(/\s+/g, ' ').trim()).digest('hex'),
      metadataValid: parsed !== null,
      ...(metadataError ? {metadataError} : {}),
    });
  }
  return {
    rootPath: resolvedRoot,
    totalArticles: articles.length,
    articles,
    contentFingerprint: createHash('sha256')
      .update(articles.map(article => `${article.relativePath}\0${article.fileHash}`).join('\0'))
      .digest('hex'),
  };
}

export function inspectAndroidInternalsWikiIdentity(
  corpus: AndroidInternalsWikiCorpus,
): AndroidInternalsWikiCorpusIdentity {
  const git = (args: string[]): string => execFileSync(
    'git',
    ['-C', corpus.rootPath, ...args],
    {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']},
  );
  const isPotentialArticlePath = (relativePath: string): boolean => {
    const normalized = relativePath.split('\\').join('/');
    const basename = path.posix.basename(normalized).toUpperCase();
    return normalized.startsWith('src/') &&
      normalized.endsWith('.md') &&
      basename !== 'README.MD' &&
      basename !== 'SUMMARY.MD';
  };
  const statusRecords = git([
    '-c',
    'core.quotePath=false',
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--',
    'src',
  ]).split('\0');
  const dirtyPaths = new Set<string>();
  for (let index = 0; index < statusRecords.length; index++) {
    const record = statusRecords[index];
    if (!record) continue;
    const status = record.slice(0, 2);
    const currentPath = record.slice(3);
    if (isPotentialArticlePath(currentPath)) dirtyPaths.add(currentPath);
    if (status.includes('R') || status.includes('C')) {
      const originalPath = statusRecords[++index] ?? '';
      if (isPotentialArticlePath(originalPath)) dirtyPaths.add(originalPath);
    }
  }
  const dirtyAcceptedArticlePaths = Array.from(dirtyPaths).sort();
  return {
    revision: git(['rev-parse', 'HEAD']).trim(),
    contentFingerprint: corpus.contentFingerprint,
    dirtyAcceptedArticlePaths,
    dirty: dirtyAcceptedArticlePaths.length > 0,
  };
}
