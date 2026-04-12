import os
from dotenv import load_dotenv
from google import genai

load_dotenv()
api_key = os.environ.get("GEMINI_API_KEY")

try:
    client = genai.Client(api_key=api_key)
    # Check 2.5 flash
    response = client.models.generate_content(
        model="gemini-2.5-flash",
        contents="Hello"
    )
    print(f"SUCCESS 2.5: {response.text}")
except Exception as e:
    print(f"ERROR 2.5: {str(e)}")

try:
    # Check flash-latest
    response = client.models.generate_content(
        model="gemini-flash-latest",
        contents="Hello"
    )
    print(f"SUCCESS LATEST: {response.text}")
except Exception as e:
    print(f"ERROR LATEST: {str(e)}")
