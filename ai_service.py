import os
import json
import logging
import google.generativeai as genai

logger = logging.getLogger(__name__)

# Configure Gemini
api_key = os.getenv("GEMINI_API_KEY")
if api_key:
    genai.configure(api_key=api_key)
else:
    logger.warning("GEMINI_API_KEY not found in environment. AI features will be disabled or use fallback mode.")

def summarize_news(articles: list[dict]) -> dict:
    """
    Summarize a list of news articles and extract sentiment and takeaways.
    Returns: {"summary": [str, str, str], "sentiment": "Bullish/Bearish/Neutral", "takeaways": [str, str]}
    """
    if not api_key:
        return {
            "summary": ["AI integration is currently disabled (API key missing).", "Please add a valid GEMINI_API_KEY to your environment.", "Standard news view is active."],
            "sentiment": "Neutral",
            "takeaways": ["API Key Missing"]
        }
        
    if not articles:
        return {
            "summary": ["No recent news available to summarize."],
            "sentiment": "Neutral",
            "takeaways": ["No Data"]
        }

    try:
        # Prepare context
        context = ""
        for i, article in enumerate(articles[:10]):  # Limit to top 10 to fit context window easily
            context += f"Headline {i+1}: {article.get('title', '')}\n"
            context += f"Snippet {i+1}: {article.get('description', '')}\n\n"
            
        prompt = f"""
        You are a seasoned financial analyst. I will provide you with recent news headlines and snippets.
        Analyze them and provide an executive briefing.
        
        News Data:
        {context}
        
        Respond ONLY with a valid JSON object matching this schema:
        {{
            "summary": ["bullet point 1", "bullet point 2", "bullet point 3"],
            "sentiment": "Bullish" | "Bearish" | "Neutral",
            "takeaways": ["key theme 1", "key theme 2"]
        }}
        """
        
        model = genai.GenerativeModel('gemini-flash-lite-latest')
        response = model.generate_content(
            prompt,
            generation_config=genai.types.GenerationConfig(
                response_mime_type="application/json",
            )
        )
        
        return json.loads(response.text)
    except Exception as e:
        logger.error(f"Error calling Gemini for news summary: {e}")
        return {
            "summary": ["Error generating AI summary.", str(e), "Please check your API key and quotas."],
            "sentiment": "Neutral",
            "takeaways": ["AI Error"]
        }

def ask_copilot(ticker: str, query: str, context: dict) -> str:
    """
    Answer a user's question about a specific stock using Gemini 1.5 Flash.
    """
    if not api_key:
        return "⚠️ AI Copilot is currently disabled because the GEMINI_API_KEY environment variable is not set."
        
    try:
        sys_prompt = f"""
        You are an expert AI Stock Analyst Copilot for StockSage.
        You are answering a user query about {ticker}.
        Use the provided context to ground your answer in reality.
        Be concise, analytical, and professional. 
        Format your response in Markdown (bolding key terms, using bullet points if helpful).
        """
        
        user_prompt = f"""
        User Query: {query}
        
        Stock Context ({ticker}):
        {json.dumps(context, indent=2)}
        """
        
        model = genai.GenerativeModel('gemini-flash-lite-latest', system_instruction=sys_prompt)
        response = model.generate_content(user_prompt)
        return response.text
    except Exception as e:
        logger.error(f"Error calling Gemini for copilot chat: {e}")
        return f"⚠️ An error occurred while generating the response: {e}"
