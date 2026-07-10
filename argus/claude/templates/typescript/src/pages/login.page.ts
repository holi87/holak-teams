import { Locator, Page } from '@playwright/test';
import { BasePage } from './base.page';
import { ENV, Role } from '../config/env';

// ADAPT-ME: example Page Object. Adjust locators to the real SPA at engagement start.
export class LoginPage extends BasePage {
  readonly path = '/'; // <-- adapt (e.g. '/login')

  readonly usernameInput: Locator;
  readonly passwordInput: Locator;
  readonly submitButton: Locator;

  constructor(page: Page) {
    super(page);
    this.usernameInput = page.getByLabel(/email|username/i);
    this.passwordInput = page.getByLabel(/password/i);
    this.submitButton = page.getByRole('button', { name: /log\s*in|sign\s*in/i });
  }

  async loginAs(role: Role): Promise<void> {
    const { username, password } = ENV.accounts[role];
    await this.goto();
    await this.usernameInput.fill(username);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
  }
}
