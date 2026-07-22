import sys
import logging
logging.basicConfig(level=logging.DEBUG)

from ai_service import ask_copilot

try:
    print(ask_copilot("AAPL", "What is AAPL?", {"market_cap": 3000000000000}))
except Exception as e:
    print("FAILED:", e)
