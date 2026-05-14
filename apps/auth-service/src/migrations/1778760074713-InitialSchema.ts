import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchema1778760074713 implements MigrationInterface {
    name = 'InitialSchema1778760074713'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."users_role_enum" AS ENUM('ADMIN', 'TRADER', 'ANALYST', 'READ_ONLY')`);
        await queryRunner.query(`CREATE TYPE "public"."users_status_enum" AS ENUM('ACTIVE', 'INACTIVE', 'SUSPENDED')`);
        await queryRunner.query(`CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "email" character varying NOT NULL, "username" character varying NOT NULL, "password_hash" character varying NOT NULL, "role" "public"."users_role_enum" NOT NULL DEFAULT 'TRADER', "status" "public"."users_status_enum" NOT NULL DEFAULT 'ACTIVE', "first_name" character varying, "last_name" character varying, "is_email_verified" boolean NOT NULL DEFAULT false, "last_login_at" TIMESTAMP, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"), CONSTRAINT "UQ_fe0bb3f6520ee0469504521e710" UNIQUE ("username"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."instruments_type_enum" AS ENUM('MAJOR', 'MINOR', 'EXOTIC')`);
        await queryRunner.query(`CREATE TABLE "instruments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "pair" character varying(7) NOT NULL, "base_currency" character varying(3) NOT NULL, "quote_currency" character varying(3) NOT NULL, "type" "public"."instruments_type_enum" NOT NULL DEFAULT 'MAJOR', "pip_size" numeric(10,6) NOT NULL, "lot_size" integer NOT NULL DEFAULT '100000', "min_lot" numeric(6,2) NOT NULL DEFAULT '0.01', "max_lot" numeric(6,2) NOT NULL DEFAULT '100', "avg_spread" numeric(8,5), "active_sessions" text, "is_active" boolean NOT NULL DEFAULT true, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_caef7f728d4d966f2f66d35c6c9" UNIQUE ("pair"), CONSTRAINT "PK_44d772c3199b38559c5fb666eb6" PRIMARY KEY ("id"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "instruments"`);
        await queryRunner.query(`DROP TYPE "public"."instruments_type_enum"`);
        await queryRunner.query(`DROP TABLE "users"`);
        await queryRunner.query(`DROP TYPE "public"."users_status_enum"`);
        await queryRunner.query(`DROP TYPE "public"."users_role_enum"`);
    }

}
