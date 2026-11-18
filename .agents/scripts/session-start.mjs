const payload = {
  injectSteps: [
    {
      systemMessage: {
        systemMessage:
          'Lain workspace active: follow docs/implementation/code-style.md, keep edits $0-first and fail-closed, use token-efficiency (rg + bounded read_file), and verify with `npm run verify` (8/8) + `npm test` before finishing.',
      },
    },
  ],
};

process.stdout.write(JSON.stringify(payload));
