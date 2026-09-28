---
title: Presentation showcase
---

# Presentation showcase

Every admonition spelling a consumer might already have, and code in several
languages, rendered by the restored theme.

## MkDocs admonitions

!!! note "Read this first"
    A **note** with a [link](https://example.org/), `inline code` and a list:

    - one
    - two

!!! warning
    A warning with no title of its own.

??? tip "Collapsed by default"
    The body is hidden until the reader opens it.

???+ example "Open by default"
    ```python
    def search(project: str) -> list[str]:
        return sorted(project)
    ```

## MyST and GitHub

:::{danger}
A MyST danger block.
:::

> [!IMPORTANT]
> A GitHub alert, normalized to the same internal representation.

## Colon directives

:::success[It worked]
A colon directive with a title.
:::

:::musing[An unfamiliar type]
An unknown but safe type keeps its words and renders neutrally.
:::

## Nested and rich content

!!! question "Does nesting work?"
    Yes, and mathematics survives: $E = mc^2$.

    !!! info "A nested block"
        With its own body.

## Wide equations

A display equation wider than a phone scrolls inside its own box; the page does
not scroll sideways.

$$
\varphi-\xi \approx \frac{e^2}{3} \sin 2\varphi\ (\max 7.7' \approx 14\ \mathrm{km}),\ \varphi-\psi \approx \frac{e^2}{2} \sin 2\varphi\ (\max 11.5' \approx 21\ \mathrm{km})
$$

## Cards

The Material for MkDocs spelling of a card grid:

<div class="grid cards" markdown>

-   [![](../assets/catalog-mark.svg)](guide/index.md)
    **[The guide](guide/index.md)**
    A tour of the Markdown constructs the profile accepts.

-   [![](../assets/logo.svg)](reference.rst)
    **[The reference](reference.rst)**
    The same constructs, written in reStructuredText.

-   **[The workshop](https://www.example.org/)**
    A card with no image, linking off the site.

-   [![The rendering reference](../assets/logo.svg)](reference.rst)
    **[Code in the guide](guide/index.md#code)**
    A thumbnail that goes somewhere other than its title.

-   **[A card with code](guide/index.md#code)**
    Its code example keeps its own Copy button:

    ```python
    print("hello")
    ```

</div>

The same grid with a column hint, a maximum - `:::cards{columns=2}`, or
`<div class="grid cards cols-2" markdown>`. It never uses more than two columns,
and still drops to one on a phone:

:::cards{columns=2}

- **[The guide](guide/index.md)**
  Every construct of the content profile, one at a time.

- **[The reference](reference.rst)**
  The same constructs, in reStructuredText.

- **[The workshop](https://www.example.org/)**
  A card linking off the site.

:::

## Code in several languages

```python
import numpy as np

def mean(values: list[float]) -> float:
    """Return the arithmetic mean."""
    return float(np.mean(values))
```

```sh
freva-portal-builder build --source-root . --config portal.yaml --out build/portal
```

```js
const total = items.reduce((sum, item) => sum + item.size, 0);
```

```ts
export interface Dataset { id: string; variables: string[] }
```

```json
{ "project": "example", "variables": ["tas", "pr"] }
```

```yml
project: example
variables:
  - tas
  - pr
```

```toml
[project]
name = "example"
```

```html
<section class="portal-hero"><h1>Title</h1></section>
```

```css
.portal-hero { margin: 0 }
```

```sql
SELECT id, variable FROM datasets WHERE project = 'example';
```

```dockerfile
FROM node:24-bookworm-slim
WORKDIR /srv
```

```markdown
# A heading

Some *emphasis*.
```

```rst
Title
=====

A paragraph.
```

```console
$ freva-portal-builder verify --dir build/portal
info FP1603: Artifact contains 747 files.
```

```
No language at all: readable plain text.
```
