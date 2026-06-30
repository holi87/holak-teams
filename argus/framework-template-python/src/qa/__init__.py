"""Argus QA support layer — config, API client, schema oracle, pages, data factories.

Tests import from this package; they never touch raw config/auth directly.
Dependency direction: tests -> qa.pages / qa.data / qa.api_client -> qa.config.
"""
