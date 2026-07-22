import requests
try:
    res = requests.post('http://127.0.0.1:8000/api/screener/advanced', json={'query': "Sector = 'Technology Services' AND Revenue Growth >= 20 AND ROIC >= 15", 'limit': 100})
    print(res.status_code)
    data = res.json()
    print("Len:", len(data.get('data', [])))
    if data.get('data'): print(data['data'][0])
except Exception as e:
    print(e)
