from flask import Flask
app = Flask(__name__)

@app.route('/')
def home():
    return 'OK - Server is working!'

if __name__ == '__main__':
    print('Iniciando servidor en http://localhost:5002...')
    app.run(host='127.0.0.1', port=5002, use_reloader=False)
