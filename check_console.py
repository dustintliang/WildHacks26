from playwright.sync_api import sync_playwright

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        
        def handle_console(msg):
            if msg.type == "error":
                print(f"CONSOLE ERROR: {msg.text}")
            else:
                print(f"CONSOLE {msg.type}: {msg.text}")

        page.on("console", handle_console)
        
        page.goto("http://localhost:5173/")
        page.wait_for_selector("text=Run Demo", timeout=5000)
        page.click("text=Run Demo")
        
        # Wait for either completion or error to appear in console
        page.wait_for_timeout(5000)
        
        browser.close()

if __name__ == "__main__":
    run()
