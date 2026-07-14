import os
from dotenv import load_dotenv

load_dotenv(override=True)

DB_PATH: str = os.getenv("DB_PATH", "fitrack.db")
