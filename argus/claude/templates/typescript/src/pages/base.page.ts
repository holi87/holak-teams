import { Page } from '@playwright/test';

// Base for all Page Objects: shared navigation + helpers.
// POM rules: locators live in the page class (getByRole/getByLabel — never CSS tied to styling),
// methods express USER intent (login(), addItem()), assertions stay in the spec.
export abstract class BasePage {
  constructor(protected readonly page: Page) {}

  abstract readonly path: string;

  async goto(): Promise<void> {
    await this.page.goto(this.path);
  }
}
