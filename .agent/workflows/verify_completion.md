---
description: Verify task completion by running build and lint in parallel
---

1. Run linting to check for code quality issues.
2. Run build to ensure the application compiles correctly.

```bash
# // turbo-all
npm run lint & npm run build & wait
```
