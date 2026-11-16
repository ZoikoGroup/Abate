// tests/declarations.d.ts
// Ambient type definitions for Playwright and Axe test specifications (Guide §F.8)

declare module "@playwright/test" {
  export interface Locator {
    fill(value: string): Promise<void>;
    click(): Promise<void>;
    check(): Promise<void>;
    uncheck(): Promise<void>;
    inputValue(): Promise<string>;
    setInputFiles(
      files:
        | string
        | string[]
        | { name: string; mimeType: string; buffer: any }
        | Array<{ name: string; mimeType: string; buffer: any }>
    ): Promise<void>;
    selectOption(value: string | { label?: string | RegExp; value?: string }): Promise<string[]>;
    isVisible(): Promise<boolean>;
    isEnabled(): Promise<boolean>;
    first(): Locator;
    last(): Locator;
    nth(index: number): Locator;
    getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): Locator;
    getByLabel(label: string | RegExp, options?: { exact?: boolean }): Locator;
    getByText(text: string | RegExp, options?: { exact?: boolean }): Locator;
    locator(selector: string): Locator;
    or(locator: Locator): Locator;
  }

  export interface Page {
    goto(url: string): Promise<any>;
    waitForLoadState(state?: "load" | "domcontentloaded" | "networkidle"): Promise<any>;
    waitForTimeout(timeout: number): Promise<void>;
    getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): Locator;
    getByLabel(label: string | RegExp, options?: { exact?: boolean }): Locator;
    getByText(text: string | RegExp, options?: { exact?: boolean }): Locator;
    locator(selector: string): Locator;
  }

  export interface TestArgs {
    page: Page;
  }

  export interface TestFunction {
    (name: string, testFn: (args: TestArgs) => Promise<void> | void): void;
    describe: (name: string, fn: () => void) => void;
    beforeEach?: (fn: (args: TestArgs) => Promise<void> | void) => void;
    afterEach?: (fn: (args: TestArgs) => Promise<void> | void) => void;
  }

  export const test: TestFunction;

  export interface ExpectMatcher {
    toBeVisible(options?: { timeout?: number }): Promise<void>;
    toBeEnabled(options?: { timeout?: number }): Promise<void>;
    toHaveText(expected: string | RegExp | Array<string | RegExp>, options?: { timeout?: number }): Promise<void>;
    toHaveCount(count: number, options?: { timeout?: number }): Promise<void>;
    toEqual(expected: any): Promise<void>;
    toBe(expected: any): Promise<void>;
    toBeTruthy(): Promise<void>;
    toBeFalsy(): Promise<void>;
  }

  export function expect(actual: any): ExpectMatcher;
  export function defineConfig(config: any): any;
  export const devices: Record<string, any>;
}

declare module "@axe-core/playwright" {
  export interface AxeResultNode {
    html: string;
    target: string[];
    failureSummary?: string;
  }

  export interface AxeViolation {
    id: string;
    impact?: "minor" | "moderate" | "serious" | "critical" | null;
    description: string;
    help: string;
    helpUrl: string;
    nodes: AxeResultNode[];
  }

  export interface AxeResults {
    violations: AxeViolation[];
    passes: any[];
    incomplete: any[];
    inapplicable: any[];
  }

  export default class AxeBuilder {
    constructor(args: { page: any });
    withTags(tags: string[]): this;
    exclude(selector: string): this;
    analyze(): Promise<AxeResults>;
  }
}

declare namespace NodeJS {
  interface ProcessEnv {
    [key: string]: string | undefined;
  }
  interface Process {
    env: ProcessEnv;
  }
}

declare const process: NodeJS.Process;

declare const Buffer: {
  from(data: string | Uint8Array | Array<number>, encoding?: string): any;
};
