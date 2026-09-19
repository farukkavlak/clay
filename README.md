# Clay

**Clay** is an Infrastructure-as-Code engine: you describe resources in a config file, and Clay works out what to create, change or destroy, then does it.

## 🚀 Features

- **Custom DSL:** Simple, config-based syntax for defining resources.
- **State Management:** JSON-based state file for reconciliation.
- **Dependency Graph:** DAG-based execution ordering.
- **Local Provider:**

## 📦 Installation

```bash
npm install
```

## 🛠 Usage

1.  Initialize a new workspace:

    ```bash
    npm run clay init
    ```

2.  Create a `main.clay` file:

    ```
    resource "file" "example" {
      path = "./hello.txt"
      content = "Hello Clay!"
    }
    ```

3.  Apply changes:
    ```bash
    npm run clay apply
    ```

## 📝 License

ISC
