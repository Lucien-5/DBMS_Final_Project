const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

// Prevent browser from caching stale HTML/JS during rapid development
app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
});

app.use(express.static(path.join(__dirname, 'public'), {
    etag: false,
    maxAge: 0
}));

app.use('/posters', express.static(path.join(__dirname, '..', 'posters'), {
    etag: false,
    maxAge: 0
}));

// Database Connection Pool
const pool = mysql.createPool({
    host: '127.0.0.1',
    user: 'root',
    password: '',
    database: 'filmcraft',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    multipleStatements: false // Critical security guardrail against SQL injection
});

// Test connection
pool.getConnection()
    .then(conn => {
        console.log('✓ Successfully connected to MySQL `filmcraft` database');
        conn.release();
    })
    .catch(err => {
        console.error('✗ Failed to connect to MySQL `filmcraft` database:', err.message);
    });

// --------------------------------------------------------------------
// API 1: List all movies with ratings, director, and genres
// Uses derived table pre-aggregation to prevent Cartesian fan-out multiplication
// --------------------------------------------------------------------
app.get('/api/movies', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT 
                M.movie_id,
                M.title,
                M.release_year,
                M.duration_minutes,
                M.language,
                M.synopsis,
                M.poster_url,
                M.prequel_movie_id,
                P.title AS prequel_title,
                FP.name AS director_name,
                MG_Agg.genres,
                COALESCE(R_Agg.total_reviews, 0) AS total_reviews,
                COALESCE(R_Agg.average_rating, 0.0) AS average_rating
            FROM movies M
            LEFT JOIN movies P ON M.prequel_movie_id = P.movie_id
            LEFT JOIN movie_cast_crew MCC ON M.movie_id = MCC.movie_id AND MCC.role_type = 'DIRECTOR'
            LEFT JOIN film_professionals FP ON MCC.person_id = FP.person_id
            LEFT JOIN (
                SELECT movie_id, GROUP_CONCAT(genre_name ORDER BY genre_name SEPARATOR ', ') AS genres
                FROM movie_genres
                GROUP BY movie_id
            ) MG_Agg ON M.movie_id = MG_Agg.movie_id
            LEFT JOIN (
                SELECT 
                    movie_id, 
                    COUNT(review_id) AS total_reviews, 
                    ROUND(AVG(rating), 1) AS average_rating
                FROM reviews
                GROUP BY movie_id
            ) R_Agg ON M.movie_id = R_Agg.movie_id
            ORDER BY average_rating DESC, release_year DESC;
        `);
        res.json({ success: true, count: rows.length, data: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --------------------------------------------------------------------
// API 1b: Community Reviews for a Specific Movie
// --------------------------------------------------------------------
app.get('/api/movies/:id/reviews', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT 
                R.review_id,
                R.user_id,
                U.username,
                U.role,
                C.membership_tier,
                FC.publication_name,
                R.rating,
                R.review_text,
                R.contains_spoilers,
                R.watch_date,
                R.created_at
            FROM reviews R
            JOIN users U ON R.user_id = U.user_id
            LEFT JOIN cinephiles C ON U.user_id = C.user_id
            LEFT JOIN film_critics FC ON U.user_id = FC.user_id
            WHERE R.movie_id = ?
            ORDER BY R.created_at DESC;
        `, [req.params.id]);
        res.json({ success: true, count: rows.length, data: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --------------------------------------------------------------------
// API 2: Theatrical Screenings (Multi-Table 5-way Join)
// --------------------------------------------------------------------
app.get('/api/screenings', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT 
                TS.screening_id,
                T.name AS theater_name,
                T.city,
                TR.room_number,
                TR.screen_format,
                TR.seating_capacity,
                M.movie_id,
                M.title AS movie_title,
                FP.name AS director_name,
                TS.screening_datetime,
                TS.ticket_price,
                (TR.seating_capacity * TS.ticket_price) AS potential_gross
            FROM theaters T
            JOIN theater_rooms TR ON T.theater_id = TR.theater_id
            JOIN theater_screenings TS ON TR.theater_id = TS.theater_id AND TR.room_number = TS.room_number
            JOIN movies M ON TS.movie_id = M.movie_id
            LEFT JOIN movie_cast_crew MCC ON M.movie_id = MCC.movie_id AND MCC.role_type = 'DIRECTOR'
            LEFT JOIN film_professionals FP ON MCC.person_id = FP.person_id
            ORDER BY TS.screening_datetime ASC;
        `);
        res.json({ success: true, count: rows.length, data: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --------------------------------------------------------------------
// API 2b: Get Theaters and Screening Rooms
// --------------------------------------------------------------------
app.get('/api/theaters', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT 
                T.theater_id,
                T.name AS theater_name,
                T.city,
                TR.room_number,
                TR.screen_format,
                TR.seating_capacity
            FROM theaters T
            JOIN theater_rooms TR ON T.theater_id = TR.theater_id
            ORDER BY T.name ASC, TR.room_number ASC;
        `);
        res.json({ success: true, data: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --------------------------------------------------------------------
// API 2c: Add / Update Screening
// --------------------------------------------------------------------
app.post('/api/screenings', async (req, res) => {
    const { theater_id, room_number, movie_id, screening_datetime, ticket_price } = req.body;
    if (!theater_id || !room_number || !movie_id || !screening_datetime || !ticket_price) {
        return res.status(400).json({ success: false, error: 'All screening fields are required.' });
    }

    try {
        const [result] = await pool.query(`
            INSERT INTO theater_screenings (theater_id, room_number, movie_id, screening_datetime, ticket_price)
            VALUES (?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE ticket_price = VALUES(ticket_price);
        `, [theater_id, room_number, movie_id, screening_datetime, ticket_price]);

        res.json({ success: true, message: 'Screening successfully scheduled.', id: result.insertId });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --------------------------------------------------------------------
// API 2d: Festivals, Curators, Awards & Nominations
// --------------------------------------------------------------------
app.get('/api/festivals', async (req, res) => {
    try {
        const [festivals] = await pool.query(`
            SELECT 
                F.festival_id,
                F.name AS festival_name,
                F.city,
                F.established_year,
                COUNT(DISTINCT FA.award_id) AS total_awards_catalogued,
                COUNT(DISTINCT AN.nomination_id) AS total_nominations
            FROM festivals F
            LEFT JOIN festival_awards FA ON F.festival_id = FA.festival_id
            LEFT JOIN award_nominations AN ON FA.award_id = AN.award_id
            GROUP BY F.festival_id, F.name, F.city, F.established_year
            ORDER BY F.established_year ASC;
        `);

        const [awards] = await pool.query(`
            SELECT 
                FA.award_id,
                F.festival_id,
                F.name AS festival_name,
                F.city,
                FA.category_name,
                FA.award_year,
                M.movie_id,
                M.title AS movie_title,
                FP.name AS nominee_name,
                AN.is_winner
            FROM festival_awards FA
            JOIN festivals F ON FA.festival_id = F.festival_id
            JOIN award_nominations AN ON FA.award_id = AN.award_id
            JOIN movies M ON AN.movie_id = M.movie_id
            LEFT JOIN film_professionals FP ON AN.person_id = FP.person_id
            ORDER BY FA.award_year DESC, F.name ASC;
        `);

        const [curators] = await pool.query(`
            SELECT 
                FC.user_id,
                U.username,
                U.email,
                FC.festival_organization,
                FC.accreditation_id
            FROM festival_curators FC
            JOIN users U ON FC.user_id = U.user_id
            ORDER BY FC.festival_organization ASC;
        `);

        res.json({ success: true, festivals, awards, curators });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --------------------------------------------------------------------
// API 3: Relational Division Query (Universal Quantification: R / S)
// "Find all cinephiles who reviewed EVERY Christopher Nolan film"
// --------------------------------------------------------------------
app.get('/api/division/nolan', async (req, res) => {
    try {
        const [nolanMovies] = await pool.query(`
            SELECT M.movie_id, M.title, M.release_year
            FROM movies M
            JOIN movie_cast_crew MCC ON M.movie_id = MCC.movie_id
            WHERE MCC.person_id = 1 AND MCC.role_type = 'DIRECTOR'
            ORDER BY M.release_year ASC;
        `);

        const [divisionWinners] = await pool.query(`
            SELECT 
                U.user_id,
                U.username,
                U.email,
                U.role,
                C.membership_tier,
                C.favorite_genre
            FROM users U
            JOIN cinephiles C ON U.user_id = C.user_id
            WHERE NOT EXISTS (
                SELECT M.movie_id
                FROM movies M
                JOIN movie_cast_crew MCC ON M.movie_id = MCC.movie_id
                WHERE MCC.person_id = 1 AND MCC.role_type = 'DIRECTOR'
                AND NOT EXISTS (
                    SELECT 1
                    FROM reviews R
                    WHERE R.user_id = U.user_id
                      AND R.movie_id = M.movie_id
                )
            );
        `);

        res.json({
            success: true,
            director: 'Christopher Nolan',
            total_nolan_movies: nolanMovies.length,
            nolan_movies: nolanMovies,
            division_winners: divisionWinners,
            relational_algebra: "π_{user_id}(Reviews) ÷ π_{movie_id}(σ_{name='Christopher Nolan' ∧ role='DIRECTOR'}(FilmProfessional ⨝ MovieCastCrew))"
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --------------------------------------------------------------------
// API 4: Director Leaderboard (Aggregations with HAVING)
// Pre-aggregates reviews and awards to prevent Cartesian product fan-out
// --------------------------------------------------------------------
app.get('/api/directors', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT 
                FP.person_id,
                FP.name AS director_name,
                FP.nationality,
                COUNT(DISTINCT MCC.movie_id) AS total_films_directed,
                COALESCE(SUM(R_Agg.total_reviews), 0) AS total_reviews,
                COALESCE(ROUND(AVG(R_Agg.average_rating), 2), 0.00) AS average_rating,
                COALESCE(Award_Agg.awards_won, 0) AS awards_won
            FROM film_professionals FP
            JOIN movie_cast_crew MCC ON FP.person_id = MCC.person_id AND MCC.role_type = 'DIRECTOR'
            LEFT JOIN (
                SELECT movie_id, COUNT(review_id) AS total_reviews, AVG(rating) AS average_rating
                FROM reviews
                GROUP BY movie_id
            ) R_Agg ON MCC.movie_id = R_Agg.movie_id
            LEFT JOIN (
                SELECT 
                    person_id,
                    SUM(CASE WHEN is_winner = TRUE THEN 1 ELSE 0 END) AS awards_won
                FROM award_nominations
                GROUP BY person_id
            ) Award_Agg ON FP.person_id = Award_Agg.person_id
            GROUP BY FP.person_id, FP.name, FP.nationality, Award_Agg.awards_won
            ORDER BY average_rating DESC, total_reviews DESC;
        `);
        res.json({ success: true, data: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --------------------------------------------------------------------
// API 5: Extremal Comparison (>= ALL) - Top Rated Movies
// --------------------------------------------------------------------
app.get('/api/extremal/top', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT 
                M.movie_id,
                M.title,
                COUNT(R.review_id) AS num_perfect_scores
            FROM movies M
            JOIN reviews R ON M.movie_id = R.movie_id
            WHERE R.rating = 5
            GROUP BY M.movie_id, M.title
            HAVING COUNT(R.review_id) >= ALL (
                SELECT COUNT(R2.review_id)
                FROM reviews R2
                WHERE R2.rating = 5
                GROUP BY R2.movie_id
            );
        `);
        res.json({ success: true, data: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --------------------------------------------------------------------
// API 6: Submit a Review (Atomic Transaction)
// --------------------------------------------------------------------
app.post('/api/reviews', async (req, res) => {
    const { user_id, movie_id, rating, review_text, contains_spoilers } = req.body;

    const parsedRating = parseInt(rating, 10);
    if (!user_id || !movie_id || isNaN(parsedRating) || parsedRating < 0 || parsedRating > 5) {
        return res.status(400).json({ success: false, error: 'Valid user_id, movie_id, and rating (0-5 stars) are required.' });
    }

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        // 1. Insert or update the review
        await conn.query(`
            INSERT INTO reviews (user_id, movie_id, rating, review_text, contains_spoilers, watch_date, created_at)
            VALUES (?, ?, ?, ?, ?, CURDATE(), NOW())
            ON DUPLICATE KEY UPDATE 
                rating = VALUES(rating), 
                review_text = VALUES(review_text),
                contains_spoilers = VALUES(contains_spoilers),
                watch_date = VALUES(watch_date);
        `, [user_id, movie_id, parsedRating, review_text || '', contains_spoilers ? 1 : 0]);

        // 2. Fetch the movie's primary genre
        const [genreRows] = await conn.query(`
            SELECT genre_name FROM movie_genres WHERE movie_id = ? LIMIT 1;
        `, [movie_id]);

        if (genreRows.length > 0) {
            await conn.query(`
                UPDATE cinephiles 
                SET favorite_genre = ? 
                WHERE user_id = ?;
            `, [genreRows[0].genre_name, user_id]);
        }

        await conn.commit();
        res.json({ success: true, message: 'Review successfully recorded via ACID transaction.' });
    } catch (err) {
        await conn.rollback();
        res.status(500).json({ success: false, error: err.message });
    } finally {
        conn.release();
    }
});

// --------------------------------------------------------------------
// API 7: SQL Injection Demonstration Endpoint (Ch 7 Proof)
// --------------------------------------------------------------------
app.get('/api/search', async (req, res) => {
    const query = req.query.q || '';
    try {
        // Safe Parameterized Query
        const [rows] = await pool.query(`
            SELECT movie_id, title, release_year, synopsis 
            FROM movies 
            WHERE title LIKE ? OR synopsis LIKE ?;
        `, [`%${query}%`, `%${query}%`]);

        res.json({
            success: true,
            input_query: query,
            matched_records: rows.length,
            is_sanitized: true,
            security_note: "Input is bound to parameters; SQL injection payloads like `' OR '1'='1` are safely treated as raw string literals.",
            results: rows
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --------------------------------------------------------------------
// API 8: Film Professionals & Accolades (Talent & Award Details)
// Pre-aggregates roles, filmographies, and awards to prevent Cartesian fan-out
// --------------------------------------------------------------------
app.get('/api/professionals', async (req, res) => {
    try {
        const [professionals] = await pool.query(`
            SELECT 
                FP.person_id,
                FP.name,
                FP.nationality,
                FP.birth_date,
                FP.biography,
                COALESCE(Roles_Agg.roles, 'Artist') AS roles,
                COALESCE(Films_Agg.filmography, 'None') AS filmography,
                COALESCE(Award_Agg.total_nominations, 0) AS total_nominations,
                COALESCE(Award_Agg.total_awards_won, 0) AS total_awards_won
            FROM film_professionals FP
            LEFT JOIN (
                SELECT person_id, GROUP_CONCAT(DISTINCT role_type ORDER BY role_type SEPARATOR ', ') AS roles
                FROM movie_cast_crew
                GROUP BY person_id
            ) Roles_Agg ON FP.person_id = Roles_Agg.person_id
            LEFT JOIN (
                SELECT MCC.person_id, GROUP_CONCAT(DISTINCT CONCAT(M.title, ' (', M.release_year, ')') ORDER BY M.release_year SEPARATOR '; ') AS filmography
                FROM movie_cast_crew MCC
                JOIN movies M ON MCC.movie_id = M.movie_id
                GROUP BY MCC.person_id
            ) Films_Agg ON FP.person_id = Films_Agg.person_id
            LEFT JOIN (
                SELECT person_id, COUNT(*) AS total_nominations, SUM(CASE WHEN is_winner = 1 THEN 1 ELSE 0 END) AS total_awards_won
                FROM award_nominations
                WHERE person_id IS NOT NULL
                GROUP BY person_id
            ) Award_Agg ON FP.person_id = Award_Agg.person_id
            ORDER BY total_awards_won DESC, total_nominations DESC, FP.name ASC;
        `);

        const [individualAwards] = await pool.query(`
            SELECT 
                AN.nomination_id,
                AN.person_id,
                FP.name AS person_name,
                FA.category_name,
                FA.award_year,
                F.name AS festival_name,
                F.city,
                M.title AS movie_title,
                AN.is_winner
            FROM award_nominations AN
            JOIN festival_awards FA ON AN.award_id = FA.award_id
            JOIN festivals F ON FA.festival_id = F.festival_id
            JOIN movies M ON AN.movie_id = M.movie_id
            JOIN film_professionals FP ON AN.person_id = FP.person_id
            ORDER BY FA.award_year DESC, AN.is_winner DESC;
        `);

        res.json({
            success: true,
            data: professionals,
            awards: individualAwards
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --------------------------------------------------------------------
// API 9: List Users (for Reviewer and Community Selects)
// --------------------------------------------------------------------
app.get('/api/users', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT 
                U.user_id,
                U.username,
                U.email,
                U.role,
                COALESCE(C.membership_tier, '') AS membership_tier,
                COALESCE(FC.publication_name, '') AS publication_name
            FROM users U
            LEFT JOIN cinephiles C ON U.user_id = C.user_id
            LEFT JOIN film_critics FC ON U.user_id = FC.user_id
            ORDER BY U.user_id ASC;
        `);
        res.json({ success: true, data: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --------------------------------------------------------------------
// API 10: Create Account (Register as Reviewer / Cinephile / Critic)
// Atomic transaction inserting into users and disjoint specialized subclass
// --------------------------------------------------------------------
app.post('/api/users', async (req, res) => {
    const { username, email, role, membership_tier, favorite_genre, publication_name } = req.body;

    if (!username || !email) {
        return res.status(400).json({ success: false, error: 'Username and email are required.' });
    }

    const assignedRole = (role === 'CRITIC') ? 'CRITIC' : 'CINEPHILE';
    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();

        // 1. Insert into superclass users
        const [userResult] = await conn.query(`
            INSERT INTO users (username, email, password_hash, role, created_at)
            VALUES (?, ?, '$argon2id$v=19$m=65536,t=3,p=4$filmcraft_seed_hash', ?, NOW());
        `, [username.trim(), email.trim(), assignedRole]);

        const newUserId = userResult.insertId;

        // 2. Insert into specialized subclass
        if (assignedRole === 'CINEPHILE') {
            const tier = ['FREE', 'PRO', 'PATRON'].includes(membership_tier) ? membership_tier : 'FREE';
            await conn.query(`
                INSERT INTO cinephiles (user_id, role, membership_tier, favorite_genre)
                VALUES (?, 'CINEPHILE', ?, ?);
            `, [newUserId, tier, favorite_genre || 'Drama']);
        } else {
            const pub = publication_name ? publication_name.trim() : 'Independent Film Press';
            const licenseNo = `LIC-${Date.now().toString().slice(-6)}`;
            await conn.query(`
                INSERT INTO film_critics (user_id, role, publication_name, critic_license_no, is_verified)
                VALUES (?, 'CRITIC', ?, ?, 1);
            `, [newUserId, pub, licenseNo]);
        }

        await conn.commit();
        res.json({
            success: true,
            user: {
                user_id: newUserId,
                username: username.trim(),
                email: email.trim(),
                role: assignedRole
            }
        });
    } catch (err) {
        await conn.rollback();
        res.status(500).json({ success: false, error: err.message });
    } finally {
        conn.release();
    }
});

// --------------------------------------------------------------------
// API 11: Add Movie (Catalog new film with optional image)
// --------------------------------------------------------------------
app.post('/api/movies', async (req, res) => {
    const { title, release_year, duration_minutes, language, synopsis, poster_url, genre_name, director_name, prequel_movie_id } = req.body;

    if (!title || !release_year || !duration_minutes) {
        return res.status(400).json({ success: false, error: 'Title, release year, and duration (in minutes) are required.' });
    }

    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();

        // Normalize poster URL / path if a local file path was pasted
        let normalizedPoster = poster_url && poster_url.trim() ? poster_url.trim() : null;
        if (normalizedPoster) {
            if (normalizedPoster.includes('posters/')) {
                normalizedPoster = '/posters/' + path.basename(normalizedPoster);
            } else if (!normalizedPoster.startsWith('http://') && !normalizedPoster.startsWith('https://') && !normalizedPoster.startsWith('/')) {
                normalizedPoster = '/posters/' + normalizedPoster;
            }
        }

        // 1. Insert into movies table
        const [movieResult] = await conn.query(`
            INSERT INTO movies (title, release_year, duration_minutes, language, synopsis, poster_url, prequel_movie_id)
            VALUES (?, ?, ?, ?, ?, ?, ?);
        `, [
            title.trim(),
            parseInt(release_year, 10),
            parseInt(duration_minutes, 10),
            language ? language.trim() : 'English',
            synopsis ? synopsis.trim() : null,
            normalizedPoster,
            prequel_movie_id ? parseInt(prequel_movie_id, 10) : null
        ]);

        const newMovieId = movieResult.insertId;

        // 2. Insert genre if provided
        if (genre_name && genre_name.trim()) {
            await conn.query(`
                INSERT INTO movie_genres (movie_id, genre_name)
                VALUES (?, ?);
            `, [newMovieId, genre_name.trim()]);
        }

        // 3. Link or insert director if provided
        if (director_name && director_name.trim()) {
            const dirName = director_name.trim();
            const [existing] = await conn.query(`
                SELECT person_id FROM film_professionals WHERE name = ? LIMIT 1;
            `, [dirName]);

            let personId;
            if (existing.length > 0) {
                personId = existing[0].person_id;
            } else {
                const [personResult] = await conn.query(`
                    INSERT INTO film_professionals (name, nationality, biography)
                    VALUES (?, 'International', 'Filmmaker catalogued in archive.');
                `, [dirName]);
                personId = personResult.insertId;
            }

            await conn.query(`
                INSERT INTO movie_cast_crew (movie_id, person_id, role_type)
                VALUES (?, ?, 'DIRECTOR');
            `, [newMovieId, personId]);
        }

        await conn.commit();
        res.json({
            success: true,
            movie: {
                movie_id: newMovieId,
                title: title.trim(),
                release_year: parseInt(release_year, 10)
            }
        });
    } catch (err) {
        await conn.rollback();
        res.status(500).json({ success: false, error: err.message });
    } finally {
        conn.release();
    }
});

app.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`🎬 FilmCraft Web Server is running!`);
    console.log(`🌐 Local URL: http://localhost:${PORT}`);
    console.log(`====================================================`);
});
